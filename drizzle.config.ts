import { defineConfig } from 'drizzle-kit';
import { join } from 'path';
import { xdgState } from 'xdg-basedir';

const STATE_DIR = join(xdgState!, 'proton-drive-sync');
const DB_PATH = join(STATE_DIR, 'state.db');

export default defineConfig({
    schema: './src/db/schema.ts',
    out: './src/db/migrations',
    dialect: 'sqlite',
    dbCredentials: {
        url: DB_PATH,
    },
});
