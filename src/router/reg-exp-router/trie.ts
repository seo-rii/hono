import { splitRoutingPath } from '../../utils/url'
import { createNullObject } from '../utils'
import type { Context, ParamAssocArray } from './node'
import { Node } from './node'

export type ReplacementMap = number[]

function hasCompatibleLookahead(next: string): boolean {
  let inClass = false
  for (let i = 0; i < next.length; i++) {
    const character = next[i]
    if (character === '\\') {
      i++
    } else if (character === '[') {
      inClass = true
    } else if (character === ']') {
      inClass = false
    } else if (character === '$' && !inClass) {
      // A successful probe at EOF cannot prove compatibility for longer paths.
      return false
    }
  }
  const prefix = next.indexOf('*') === next.length - 1 ? next.slice(0, -1) : next
  try {
    // TrieRouter embeds the next segment unescaped in a lookahead. Probe after
    // a nonempty capture, using the shortest segment a prefixed wildcard accepts.
    return new RegExp('^_(?=/' + next + ')').test('_/' + prefix)
  } catch {
    return false
  }
}

export class Trie {
  #context: Context = { varIndex: 0, path: '' }
  #root: Node = new Node()
  #index: number = 0
  // path -> [handler index (-1 for a static path), param assoc, node keys along the branch]
  paths: Record<string, [number, ParamAssocArray, string[]]> = createNullObject()

  get usedDisjoint(): boolean {
    return this.#context.usedDisjoint ?? false
  }

  get unsafePath(): string | undefined {
    return this.#context.unsafePath
  }

  insert(path: string, isStatic: boolean): void {
    this.#context.path = path
    const keys: string[] = []
    if (isStatic) {
      // a static path has no pattern; every character is a literal token
      this.#root.insert(path.split(''), -1, [], this.#context, keys)
      this.paths[path] = [-1, [], keys]
      return
    }

    const parts = splitRoutingPath(path)
    for (let i = 0; i < parts.length - 1; i++) {
      const next = parts[i + 1]
      if (
        /^:[^{}]+\{.+\}$/.test(parts[i]) &&
        next &&
        next[0] !== ':' &&
        next[0] !== '*' &&
        !hasCompatibleLookahead(next)
      ) {
        this.#context.unsafePath ??= path
      }
    }

    const paramAssoc: ParamAssocArray = []

    const groups: [string, string][] = [] // [mark, original string]
    let markedPath = path
    for (let i = 0; ;) {
      let replaced = false
      markedPath = markedPath.replace(/\{(?:\{[\d,]+\}|[^}])+\}/g, (m) => {
        const mark = `@\\${i}`
        groups[i] = [mark, m]
        i++
        replaced = true
        return mark
      })
      if (!replaced) {
        break
      }
    }

    /**
     *  - pattern (:label, :label{0-9]+}, ...)
     *  - /* wildcard
     *  - character
     */
    const tokens = markedPath.match(/(?::[^\/]+)|(?:\/\*$)|./gs) || []
    for (let i = groups.length - 1; i >= 0; i--) {
      const [mark] = groups[i]
      for (let j = tokens.length - 1; j >= 0; j--) {
        if (tokens[j].indexOf(mark) !== -1) {
          tokens[j] = tokens[j].replace(mark, groups[i][1])
          break
        }
      }
    }

    this.#root.insert(tokens, this.#index, paramAssoc, this.#context, keys)
    this.paths[path] = [this.#index++, paramAssoc, keys]
  }

  buildRegExp(): [RegExp, ReplacementMap, ReplacementMap] {
    let regexp = this.#root.buildRegExpStr()
    if (regexp === '') {
      return [/^$/, [], []] // never match
    }

    let captureIndex = 0
    const indexReplacementMap: ReplacementMap = []
    const paramReplacementMap: ReplacementMap = []

    regexp = regexp.replace(/#(\d+)|@(\d+)|\.\*\$/g, (_, handlerIndex, paramIndex) => {
      if (handlerIndex !== undefined) {
        indexReplacementMap[++captureIndex] = Number(handlerIndex)
        return '$()'
      }
      if (paramIndex !== undefined) {
        paramReplacementMap[Number(paramIndex)] = ++captureIndex
        return ''
      }

      return ''
    })

    return [new RegExp(`^${regexp}`), indexReplacementMap, paramReplacementMap]
  }
}
