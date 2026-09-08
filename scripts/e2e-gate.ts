import { spawnSync } from 'node:child_process';
import { chromium, firefox, webkit, type BrowserType } from '@playwright/test';

type Project = 'chromium' | 'firefox' | 'webkit' | 'mobile';

const launchers: Record<'chromium' | 'firefox' | 'webkit', BrowserType> = {
  chromium,
  firefox,
  webkit,
};
const allProjects: Project[] = ['chromium', 'firefox', 'webkit', 'mobile'];

function requestedProjects(args: string[]): { projects: Project[]; passthrough: string[] } {
  const projects: Project[] = [];
  const passthrough: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === '--') continue;
    if (arg === '--project') {
      const next = args[index + 1];
      if (next && allProjects.includes(next as Project)) projects.push(next as Project);
      index += 1;
      continue;
    }
    if (arg?.startsWith('--project=')) {
      const project = arg.slice('--project='.length);
      if (allProjects.includes(project as Project)) projects.push(project as Project);
      continue;
    }
    passthrough.push(arg);
  }
  return { projects: projects.length ? [...new Set(projects)] : allProjects, passthrough };
}

function hasWorkersOverride(args: string[]): boolean {
  return args.some((arg) => arg === '--workers' || arg.startsWith('--workers='));
}

async function main(): Promise<void> {
  const { projects, passthrough } = requestedProjects(process.argv.slice(2));
  const available = new Set<Project>();
  const unavailable: string[] = [];
  for (const project of new Set(projects)) {
    const engine = project === 'mobile' ? 'chromium' : project;
    if (available.has(engine)) {
      available.add(project);
      continue;
    }
    try {
      const browser = await launchers[engine].launch({ headless: true });
      await browser.close();
      available.add(engine);
      available.add(project);
    } catch (error) {
      unavailable.push(`${project}: ${String(error).split('\n')[0]}`);
    }
  }

  const runnable = projects.filter((project) => available.has(project));
  if (runnable.length) {
    const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    const workerArgs = hasWorkersOverride(passthrough) ? [] : ['--workers=1'];
    const result = spawnSync(
      executable,
      [
        'exec',
        'playwright',
        'test',
        ...passthrough,
        ...workerArgs,
        ...runnable.map((project) => `--project=${project}`),
      ],
      { cwd: process.cwd(), stdio: 'inherit' },
    );
    if ((result.status ?? 1) !== 0) {
      process.exitCode = result.status ?? 1;
      return;
    }
  }

  if (unavailable.length) {
    console.log(`NOT RUN: browser projects unavailable: ${unavailable.join('; ')}`);
    process.exitCode = 2;
    return;
  }
  if (!runnable.length) {
    console.log('NOT RUN: no requested browser project is available.');
    process.exitCode = 2;
    return;
  }
  console.log(`PASS: Playwright projects passed: ${runnable.join(', ')}.`);
}

void main().catch((error: unknown) => {
  console.error('FAIL: Playwright gate crashed.');
  console.error(error);
  process.exitCode = 1;
});
