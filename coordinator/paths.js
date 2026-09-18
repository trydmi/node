/**
 * Where the coordinator keeps its data on disk. Kept apart from store.js so the published package
 * (`trydmi`: cli, node, the job runner, the challenge registry) can resolve paths without loading any database code.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const DATA_DIR = process.env.DMI_DATA_DIR ?? path.join(here, 'data')
