/**
 * Xcode's DerivedData records: which workspace or project a `<Name>-<hash>`
 * build folder belongs to.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { decodeXmlEntities } from './xml-entities.js';

/** `WorkspacePath` from a DerivedData folder's `info.plist` (an XML plist Xcode writes). */
export function derivedDataWorkspace(dir: string): string | undefined {
  let xml: string;
  try {
    xml = fs.readFileSync(path.join(dir, 'info.plist'), 'utf8');
  } catch {
    return undefined;
  }
  const match = /<key>WorkspacePath<\/key>\s*<string>([^<]+)<\/string>/.exec(xml);
  return match ? decodeXmlEntities(match[1]) : undefined;
}
