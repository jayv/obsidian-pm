import { parse } from 'yaml'

export const parseYaml = (raw: string): unknown => parse(raw)

export class Notice {
  hide(): void {}
}

export const Platform = { isDesktopApp: true, isMobileApp: false }

/** Minimal requestUrl backed by fetch, so JiraClient can be tested over real HTTP. */
export async function requestUrl(opts: {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
}): Promise<{ status: number; text: string; readonly json: unknown }> {
  const res = await fetch(opts.url, { method: opts.method ?? 'GET', headers: opts.headers, body: opts.body })
  const text = await res.text()
  // Mirror real Obsidian: `.json` is a getter that JSON.parses and THROWS on an
  // empty/non-JSON body. Callers must not touch it for 204/empty responses.
  return {
    status: res.status,
    text,
    get json() {
      return JSON.parse(text)
    }
  }
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
}

export function parseLinktext(linktext: string): { path: string; subpath: string } {
  const hash = linktext.indexOf('#')
  return hash < 0
    ? { path: linktext, subpath: '' }
    : { path: linktext.slice(0, hash), subpath: linktext.slice(hash) }
}

export class TAbstractFile {
  path = ''
  name = ''
  parent: TFolder | null = null
}

export class TFile extends TAbstractFile {
  basename = ''
  extension = ''
  stat = { ctime: 0, mtime: 0, size: 0 }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = []
  isRoot(): boolean {
    return this.parent === null
  }
}
