import { cellWidth, clean } from './display.mts'

type Point = { row: number; column: number }

// 选区持有屏幕快照，实时日志到达时不改变正在复制的内容
export class Selection {
  frame: string[]
  columns: number
  start: Point
  end: Point
  dragging = true
  moved = false

  constructor(frame: string[], x: number, y: number, columns: number) {
    this.frame = frame; this.columns = columns
    this.start = this.end = this.point(x, y)
  }

  point(x: number, y: number): Point { return { row: Math.max(0, Math.min(this.frame.length - 1, y - 1)), column: Math.max(0, Math.min(this.columns - 1, x - 1)) } }
  move(x: number, y: number): void {
    this.end = this.point(x, y)
    if (this.end.row !== this.start.row || this.end.column !== this.start.column) this.moved = true
  }

  range(row: number): [number, number] | undefined {
    if (!this.moved) return undefined
    const order = (point: Point) => point.row * this.columns + point.column
    const [first, last] = order(this.start) <= order(this.end) ? [this.start, this.end] : [this.end, this.start]
    if (row < first.row || row > last.row) return undefined
    return [row === first.row ? first.column : 0, row === last.row ? last.column + 1 : this.columns]
  }

  text(): string {
    return this.frame.flatMap((line, row) => {
      const range = this.range(row)
      if (!range) return []
      let column = 0, value = ''
      for (const char of clean(line)) {
        const size = cellWidth(char)
        if (size ? column + size > range[0] && column < range[1] : value.length > 0) value += char
        column += size
      }
      return [value.trimEnd()]
    }).join('\n')
  }

  highlight(line: string, row: number): string {
    const range = this.range(row)
    if (!range) return line
    let column = 0, selected = false
    return (line.match(/\x1b\[[0-9;]*m|[^]/gu) ?? []).map(token => {
      if (token.startsWith('\x1b[')) return token
      const size = cellWidth(token)
      if (size) selected = column + size > range[0] && column < range[1]
      column += size
      return selected ? '\x1b[7m' + token + '\x1b[27m' : token
    }).join('')
  }
}
