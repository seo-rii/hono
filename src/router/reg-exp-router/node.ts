import { createNullObject } from '../utils'

export const LABEL_REG_EXP_STR = '[^/]+'
// Match line terminators without changing the flags of user-defined parameter patterns.
export const ONLY_WILDCARD_REG_EXP_STR = '[^]*'
export const PREFIXED_WILDCARD_REG_EXP_STR = '[^/]*'
export const TAIL_WILDCARD_REG_EXP_STR = '(?:|/[^]*)'
export const PATH_ERROR = Symbol()

export type ParamAssocArray = [string, number][]
export interface Context {
  varIndex: number
  path: string
  usedDisjoint?: boolean
  unsafePath?: string
}

const regExpMetaChars = new Set('.\\+*[^]$()')

// Prove disjointness only for whole, nonempty atoms. Unknown expressions keep
// their existing fallback behavior rather than relying on a regexp prefix.
function firstCharacterRanges(pattern: string): [number, number][] | undefined {
  if (pattern.length === 1 && /^[A-Za-z0-9_/-]$/.test(pattern)) {
    const code = pattern.charCodeAt(0)
    return [[code, code]]
  }

  const atom = pattern.endsWith('+') ? pattern.slice(0, -1) : pattern
  if (atom === '\\d') {
    return [[48, 57]]
  }
  const match = /^\[([A-Za-z0-9_-]+)\]$/.exec(atom)
  if (!match || match[0].length !== atom.length) {
    return
  }

  const characters = match[1]
  // ASCII membership bounds the proof size even when a class repeats members
  // or overlapping ranges many times.
  const members = new Uint8Array(128)
  for (let i = 0; i < characters.length; i++) {
    const start = characters.charCodeAt(i)
    if (characters[i] === '-') {
      if (i !== 0 && i !== characters.length - 1) {
        return
      }
    } else if (characters[i + 1] === '-' && i + 2 < characters.length) {
      const end = characters.charCodeAt(i + 2)
      if (characters[i + 2] === '-' || end < start) {
        return
      }
      members.fill(1, start, end + 1)
      i += 2
      continue
    }
    members[start] = 1
  }
  const ranges: [number, number][] = []
  for (let start = 0; start < members.length; start++) {
    if (members[start]) {
      let end = start
      while (members[end + 1]) {
        end++
      }
      ranges.push([start, end])
      start = end
    }
  }
  return ranges
}

function areDisjoint(a: string, b: string): boolean {
  const left = firstCharacterRanges(a)
  const right = firstCharacterRanges(b)
  return (
    !!left &&
    !!right &&
    left.every(([leftStart, leftEnd]) =>
      right.every(([rightStart, rightEnd]) => leftEnd < rightStart || rightEnd < leftStart)
    )
  )
}

/**
 * Sort order:
 * 1. literal
 * 2. special pattern (e.g. :label{[0-9]+})
 * 3. common label pattern (e.g. :label)
 * 4. wildcard
 */
function compareKey(a: string, b: string): number {
  if (a.length === 1) {
    return b.length === 1 ? (a < b ? -1 : 1) : -1
  }
  if (b.length === 1) {
    return 1
  }

  // wildcard: the tail wildcard precedes the only wildcard, which matches a superset of it
  if (a === ONLY_WILDCARD_REG_EXP_STR || a === TAIL_WILDCARD_REG_EXP_STR) {
    return b === ONLY_WILDCARD_REG_EXP_STR ? -1 : 1
  } else if (b === ONLY_WILDCARD_REG_EXP_STR || b === TAIL_WILDCARD_REG_EXP_STR) {
    return -1
  }

  // label
  if (a === LABEL_REG_EXP_STR) {
    return 1
  } else if (b === LABEL_REG_EXP_STR) {
    return -1
  }

  return a.length === b.length ? (a < b ? -1 : 1) : b.length - a.length
}

export class Node {
  // handler index of a dynamic path, or -1 for a static path terminal
  #index?: number
  #varIndex?: number
  #children: Record<string, Node> = createNullObject()

  insert(
    tokens: readonly string[],
    index: number,
    paramMap: ParamAssocArray,
    context: Context,
    keys: string[]
  ): void {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let node: Node = this
    for (let i = 0, len = tokens.length; i < len; i++) {
      const token = tokens[i]
      const pattern =
        token.length === 1
          ? token === '*'
            ? i === len - 1
              ? ['', '', ONLY_WILDCARD_REG_EXP_STR] // '*' matches to all the trailing paths
              : tokens[i + 1][0] !== '/'
                ? null // only a '*' that ends a segment is a wildcard
                : tokens[i - 1] === '/'
                  ? ['', '', LABEL_REG_EXP_STR] // a standalone '*' takes a whole segment
                  : ['', '', PREFIXED_WILDCARD_REG_EXP_STR] // 'x*' may take nothing
            : null
          : token === '/*'
            ? ['', '', TAIL_WILDCARD_REG_EXP_STR] // '/path/to/*' also matches '/path/to'
            : token.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/)

      let nextNode: Node
      if (pattern) {
        const name = pattern[1]
        if (name && i > 0 && tokens[i - 1] !== '/') {
          // TrieRouter treats a colon inside a literal segment literally.
          context.unsafePath ??= context.path
        }
        let regexpStr = pattern[2] || LABEL_REG_EXP_STR
        if (name && pattern[2]) {
          if (new RegExp(regexpStr).test('')) {
            // an empty capture is indistinguishable from the handler marker `$()` at match time
            throw PATH_ERROR
          }
          regexpStr = regexpStr.replace(/^\((?!\?:)(?=[^)]+\)$)/, '(?:') // (a|b) => (?:a|b)
          if (/\((?!\?:)/.test(regexpStr)) {
            // prefix(?:a|b) is allowed, but prefix(a|b) is not
            throw PATH_ERROR
          }
          if (regexpStr.length === 1 && regExpMetaChars.has(regexpStr)) {
            // a single-char pattern like :x{.} is ambiguous with a literal character
            throw PATH_ERROR
          }
          if (regexpStr !== LABEL_REG_EXP_STR) {
            const ranges = firstCharacterRanges(regexpStr)
            if (!ranges || ranges.some(([start, end]) => start <= 47 && 47 <= end)) {
              // New sibling branches need unambiguous segment boundaries. A
              // slash-consuming ancestor can backtrack into another branch.
              context.unsafePath ??= context.path
            }
          }
        }

        keys.push(regexpStr)
        nextNode = node.#children[regexpStr]
        if (!nextNode) {
          if (
            regexpStr !== ONLY_WILDCARD_REG_EXP_STR &&
            (regexpStr !== TAIL_WILDCARD_REG_EXP_STR ||
              node.#children[PREFIXED_WILDCARD_REG_EXP_STR])
          ) {
            for (const k in node.#children) {
              if (
                // a single-char pattern coexists with single-char literals as a literal does
                (regexpStr.length > 1 || k.length > 1) &&
                k !== ONLY_WILDCARD_REG_EXP_STR &&
                // a prefixed wildcard only partially overlaps a tail wildcard, so the two
                // cannot be represented together
                (k !== TAIL_WILDCARD_REG_EXP_STR || regexpStr === PREFIXED_WILDCARD_REG_EXP_STR)
              ) {
                if (!areDisjoint(regexpStr, k)) {
                  throw PATH_ERROR
                }
                context.usedDisjoint = true
              }
            }
          }
          nextNode = node.#children[regexpStr] = new Node()
        }
        if (name !== '') {
          if (paramMap.some(([key]) => key === name)) {
            // RegExpRouter and TrieRouter resolve repeated names differently.
            // Preserve fallback when the new sibling proof is used.
            context.unsafePath ??= context.path
          }
          nextNode.#varIndex ??= context.varIndex++
          paramMap.push([name, nextNode.#varIndex])
        }
      } else {
        keys.push(token)
        nextNode = node.#children[token]
        if (!nextNode) {
          for (const k in node.#children) {
            if (
              k.length > 1 &&
              k !== ONLY_WILDCARD_REG_EXP_STR &&
              k !== TAIL_WILDCARD_REG_EXP_STR
            ) {
              if (!areDisjoint(token, k)) {
                throw PATH_ERROR
              }
              context.usedDisjoint = true
            }
          }
          nextNode = node.#children[token] = new Node()
        }
        if (token.length !== 1 || '{}|?@#*'.includes(token)) {
          // Keep emitter/marker ambiguities behind fallback. Literal stars can also
          // form segments such as `a**` that TrieRouter treats entirely literally.
          context.unsafePath ??= context.path
        }
      }

      node = nextNode
    }

    if (node.#index !== undefined) {
      throw PATH_ERROR
    }
    node.#index = index
  }

  buildRegExpStr(): string {
    const childKeys = Object.keys(this.#children).sort(compareKey)

    const strList = childKeys
      .map((k) => {
        const c = this.#children[k]
        const childStr = c.buildRegExpStr()
        // an empty childStr means a static-only branch, which is handled by staticMap
        return childStr === ''
          ? ''
          : (typeof c.#varIndex === 'number'
              ? `(${k})@${c.#varIndex}`
              : regExpMetaChars.has(k)
                ? `\\${k}`
                : k) + childStr
      })
      .filter(Boolean)

    if (typeof this.#index === 'number' && this.#index !== -1) {
      strList.unshift(`#${this.#index}`)
    }

    if (strList.length === 0) {
      return ''
    }
    if (strList.length === 1) {
      return strList[0]
    }

    return '(?:' + strList.join('|') + ')'
  }
}
