import { createNullObject } from '../utils'

export const LABEL_REG_EXP_STR = '[^/]+'
export const ONLY_WILDCARD_REG_EXP_STR = '.*'
export const TAIL_WILDCARD_REG_EXP_STR = '(?:|/.*)'
export const PATH_ERROR = Symbol()

export type ParamAssocArray = [string, number][]
export interface Context {
  varIndex: number
}

const regExpMetaChars = new Set('.\\+*[^]$()')

// Recognize whole, non-empty atoms only. Looking at a regexp prefix would be
// unsound for alternatives, nullable expressions, or assertions. Unknown
// expressions keep the existing UnsupportedPathError behavior.
function firstCharacterRanges(pattern: string): [number, number][] | undefined {
  // Node keys do not distinguish literal chars from one-char custom patterns.
  // Keep operators such as `|` out of this proof, even on a literal branch.
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
  const ranges: [number, number][] = []
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
      ranges.push([start, end])
      i += 2
      continue
    }
    ranges.push([start, start])
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

  // wildcard: the only wildcard (.*) precedes the tail wildcard
  if (a === ONLY_WILDCARD_REG_EXP_STR || a === TAIL_WILDCARD_REG_EXP_STR) {
    return b === TAIL_WILDCARD_REG_EXP_STR ? -1 : 1
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
    isStatic: boolean
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
              : ['', '', LABEL_REG_EXP_STR]
            : null
          : token === '/*'
            ? ['', '', TAIL_WILDCARD_REG_EXP_STR] // '/path/to/*' is /\/path\/to(?:|/.*)$
            : token.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/)

      let nextNode: Node
      if (pattern) {
        const name = pattern[1]
        let regexpStr = pattern[2] || LABEL_REG_EXP_STR
        if (name && pattern[2]) {
          if (regexpStr === '.*') {
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
        }

        nextNode = node.#children[regexpStr]
        if (!nextNode) {
          if (regexpStr !== ONLY_WILDCARD_REG_EXP_STR && regexpStr !== TAIL_WILDCARD_REG_EXP_STR) {
            for (const k in node.#children) {
              if (
                // a single-char pattern coexists with single-char literals as a literal does
                (regexpStr.length > 1 || k.length > 1) &&
                k !== ONLY_WILDCARD_REG_EXP_STR &&
                k !== TAIL_WILDCARD_REG_EXP_STR &&
                !areDisjoint(regexpStr, k)
              ) {
                throw PATH_ERROR
              }
            }
          }
          nextNode = node.#children[regexpStr] = new Node()
        }
        if (name !== '') {
          nextNode.#varIndex ??= context.varIndex++
          paramMap.push([name, nextNode.#varIndex])
        }
      } else {
        nextNode = node.#children[token]
        if (!nextNode) {
          for (const k in node.#children) {
            if (
              k.length > 1 &&
              k !== ONLY_WILDCARD_REG_EXP_STR &&
              k !== TAIL_WILDCARD_REG_EXP_STR &&
              !areDisjoint(token, k)
            ) {
              throw PATH_ERROR
            }
          }
          nextNode = node.#children[token] = new Node()
        }
      }

      node = nextNode
    }

    if (node.#index !== undefined) {
      throw PATH_ERROR
    }
    node.#index = isStatic ? -1 : index
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
