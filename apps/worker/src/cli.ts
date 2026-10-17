/**
 * Website Mover CLI. Each pipeline command is one stage (shared with the queue worker, src/stages.ts).
 *
 *   wm scan    --job jha --origin https://www.jaxha.org --profile bjm [--cache snapshots/jha/http]
 *   wm extract --job jha
 *   wm analyze --job jha
 *   wm brand   --job jha --file inputs/jha/style-guide/brand.json   the reviewed brand file: logos, fonts (docs/m3/branding.md)
 *   wm plan    --job jha [--target local] [--timezone America/New_York]
 *   wm approve --job jha --by "Name"
 *   wm execute --job jha [--target local]
 *   wm report  --job jha [--target local]
 *   wm qa      --job jha [--target local]      accessibility and responsive checks (Playwright + axe-core)
 *   wm postlaunch --job jha [--base https://www.jaxha.org] [--target local]   legacy URLs and GA4 on the live site
 *   wm rollback --job jha --confirm jha [--target local]   undo the job on the target
 * A job's GA4 measurement ID is given per command (--ga4 G-…) to plan and postlaunch: it belongs to
 * the job, not the environment.
 *
 * --target local is the Docker seed configured in .env; any other name is a target saved in the
 * web app (needs DATABASE_URL).
 *
 * Web app administration (needs DATABASE_URL):
 *   wm user add      --email a@b.org --name "Full Name" [--approver] [--password-env VAR]
 *   wm user grant    --email a@b.org [--revoke]           approver permission
 *   wm user password --email a@b.org [--password-env VAR]
 *   wm target add    --name local --url http://localhost:8088 --user wm-local [--password-env VAR]
 *   wm job register  --job jha --origin https://www.jaxha.org --profile bjm --target local --by a@b.org --rights-confirmed [--timezone ...]
 * Passwords are read from the named environment variable, or prompted for (hidden), never taken as arguments.
 */
import path from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { approvePlan, loadPlan } from '@wm/planner';
import { connectTarget } from '@wm/executor';
import { WpClient } from '@wm/wp-client';
import { runStage, type StageName } from './stages.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    job: { type: 'string' },
    origin: { type: 'string' },
    profile: { type: 'string', default: 'generic' },
    cache: { type: 'string' },
    target: { type: 'string', default: 'local' },
    by: { type: 'string' },
    timezone: { type: 'string' },
    email: { type: 'string' },
    name: { type: 'string' },
    url: { type: 'string' },
    user: { type: 'string' },
    'password-env': { type: 'string' },
    'rights-confirmed': { type: 'boolean', default: false },
    base: { type: 'string' },
    ga4: { type: 'string' },
    file: { type: 'string' },
    confirm: { type: 'string' },
    approver: { type: 'boolean', default: false },
    revoke: { type: 'boolean', default: false },
  },
});
const [command, sub] = positionals;
// pnpm runs scripts in the package directory; resolve user paths against where the command was typed.
const cwd = process.env.INIT_CWD ?? process.cwd();

const STAGES: StageName[] = ['scan', 'extract', 'analyze', 'plan', 'execute', 'report', 'qa', 'postlaunch', 'rollback'];

if (command && (STAGES as string[]).includes(command)) {
  const jobId = values.job ?? fail('--job is required');
  if (command === 'rollback' && values.confirm !== jobId) fail(`Rollback undoes the job on its target: confirm with --confirm ${jobId}`);
  const summary = await runStage(command as StageName, {
    jobId,
    source: command === 'scan' ? { origin: values.origin ?? fail('--origin is required'), profile: values.profile!, cacheDir: values.cache ? path.resolve(cwd, values.cache) : undefined } : undefined,
    target: ['plan', 'execute', 'report', 'qa', 'postlaunch', 'rollback'].includes(command) ? await cliTarget(values.target!) : undefined,
    timezone: values.timezone,
    ga4Id: values.ga4 ?? null,
    liveUrl: values.base ?? null,
    log: console.log,
  });
  console.log(summary);
} else {
  switch (command) {
    case 'brand': {
      const jobId = values.job ?? fail('--job is required');
      const file = values.file ?? fail('--file <brand.json> is required');
      const { importBrand } = await import('@wm/styleguide');
      await importBrand(jobId, path.resolve(cwd, file), console.log);
      console.log(`Imported into ${jobId}: run "wm plan" to put the design in a new plan version`);
      break;
    }
    case 'approve': {
      const jobId = values.job ?? fail('--job is required');
      const by = values.by ?? fail('--by "<your name>" is required');
      const { plan } = await loadPlan(jobId);
      const approval = await approvePlan(jobId, by);
      console.log(`Approved plan v${approval.planVersion} (${approval.planSha256.slice(0, 12)}) by ${by}:`, plan.expected);
      break;
    }
    case 'user': {
      const db = await import('@wm/db');
      await db.migrate();
      const email = values.email ?? fail('--email is required');
      if (sub === 'add') {
        const user = await db.createUser(email, values.name ?? fail('--name is required'), await secret('Password for the new user'), values.approver);
        console.log(`Added ${user.name} <${user.email}>${user.canApprove ? ' (approver)' : ''}`);
      } else if (sub === 'grant') {
        console.log((await db.setApprover(email, !values.revoke)) ? `${email} ${values.revoke ? 'can no longer' : 'can now'} approve, run and roll back migrations` : `No user ${email}`);
      } else if (sub === 'password') {
        console.log((await db.setPassword(email, await secret('New password'))) ? 'Password changed; their sessions are ended' : `No user ${email}`);
      } else fail('wm user add | wm user password | wm user grant');
      await db.closeDb();
      break;
    }
    case 'target': {
      if (sub !== 'add') fail('wm target add');
      const db = await import('@wm/db');
      await db.migrate();
      const target = await db.createTarget({
        name: values.name ?? fail('--name is required'),
        url: values.url ?? fail('--url is required'),
        wpUser: values.user ?? fail('--user is required'),
        appPassword: await secret('Application Password'),
        createdBy: null,
      });
      console.log(`Added target ${target.name}: ${target.url} as ${target.wpUser}`);
      await db.closeDb();
      break;
    }
    case 'job': {
      if (sub !== 'register') fail('wm job register');
      // A job the CLI already ran (files under data/jobs/<id>) becomes visible in the web app.
      const db = await import('@wm/db');
      await db.migrate();
      const id = values.job ?? fail('--job is required');
      const target = (await db.listTargets()).find((t) => t.name === values.target) ?? fail(`No saved target "${values.target}" (wm target add)`);
      const by = (await db.listUsers()).find((u) => u.email === values.by?.toLowerCase()) ?? fail('--by <email of a web app user> is required');
      // As in the web intake, the person registering confirms we may copy the site's content.
      if (!values['rights-confirmed']) fail('--rights-confirmed is required: confirm we have the client’s permission to copy this site’s content');
      await db.createJob({
        id,
        sourceUrl: values.origin ?? fail('--origin is required'),
        profile: values.profile!,
        targetId: target.id,
        timezone: values.timezone ?? null,
        ga4Id: null,
        styleGuide: null,
        userId: by.id,
      });
      await db.audit(id, by.id, 'job.register', { target: target.name, rightsConfirmed: true });
      console.log(`Registered job ${id} (target ${target.name})`);
      await db.closeDb();
      break;
    }
    default:
      fail(`Unknown command "${command ?? ''}". Commands: ${STAGES.join(', ')}, approve, user, target, job`);
  }
}

/** 'local' is the Docker seed from .env; other names are targets saved in the web app. */
async function cliTarget(name: string): Promise<{ name: string; client: WpClient }> {
  if (name === 'local') return { name, client: connectTarget('local') };
  const db = await import('@wm/db');
  const target = (await db.listTargets()).find((t) => t.name === name) ?? fail(`No saved target "${name}"`);
  const creds = await db.targetCredentials(target.id);
  await db.closeDb();
  return { name, client: new WpClient(creds) };
}

/** A secret from --password-env, else a hidden prompt. */
async function secret(prompt: string): Promise<string> {
  const env = values['password-env'];
  if (env) return process.env[env] ?? fail(`$${env} is not set`);
  if (!process.stdin.isTTY) fail(`No terminal to ask for the ${prompt.toLowerCase()}: use --password-env VAR`);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const answer = await new Promise<string>((resolve) => {
    rl.question(`${prompt}: `, resolve);
    // Hide what's typed.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
  });
  rl.close();
  process.stdout.write('\n');
  return answer;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
