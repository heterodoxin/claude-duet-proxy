import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const directory = process.env.DUET_TERMINAL_STATE;
if (!directory) process.exit(0);

const event = JSON.parse(readFileSync(0, 'utf8'));
const menu = event.hook_event_name === 'UserPromptSubmit' && /^\/duet(?::proxy)?\s*$/i.test(event.prompt ?? '');
if (event.session_id && (menu || ['SessionStart', 'SessionEnd', 'UserPromptSubmit'].includes(event.hook_event_name))) {
  const file = join(directory, menu ? 'menu.json' : 'session.json');
  const temporary = `${file}.${process.pid}`;
  writeFileSync(temporary, JSON.stringify({ session: event.session_id, transcript: event.transcript_path, cwd: event.cwd }), { mode: 0o600 });
  renameSync(temporary, file);
}

if (menu) {
  console.log(JSON.stringify({ decision: 'block', reason: 'Opening Duet proxy menu',
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true } }));
}
