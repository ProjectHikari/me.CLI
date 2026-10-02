export type Resource = { label: string; kind: string; dirty: boolean; error?: string }
export type Plugin = { id: string; state: string; enabled: boolean; generation: number; missing: string[]; error?: string; resources: Resource[]; provides?: string[]; required?: string[]; optional?: string[] }
export type Snapshot = { version: string; state: string; plugins: Plugin[]; stats: Record<string, number> }
export type Log = { type: 'log'; time: string; level: string; source: string; message: string }
export type Frame = Log | { type: 'ready' | 'state'; snapshot: Snapshot } | { type: 'response'; id: string; snapshot: Snapshot; error?: string }
