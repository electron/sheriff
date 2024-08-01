import { components as webhookComponents } from '@octokit/openapi-webhooks-types';

export const isMainRepo = (repo: webhookComponents['schemas']['repository-webhooks']) => {
  // electron/electron or foo/foo
  return repo.name === repo.owner.login;
};

type HookContext = {
  log: (...args: any[]) => void;
  error: (...args: any[]) => void;
};

export const hook = <T extends { id: string; name: string }>(
  fn: (event: T, context: HookContext) => Promise<void>,
): ((event: T) => Promise<void>) => {
  return async (event) => {
    const context = {
      error: (...args: any[]) => console.error(`hook(${event.id}):`, ...args),
      log: (...args: any[]) => console.log(`hook(${event.id}):`, ...args),
    };
    try {
      await fn(event, context);
    } catch (err) {
      context.error('an error occurred while handling an event:', event.name, '\n', err);
    }
  };
};

export const memoize = <A extends any[], T>(
  fn: (...args: A) => Promise<T>,
  memoizeKey?: (...args: A) => string,
): ((...args: A) => Promise<T>) & { invalidate: () => void } => {
  let val: Record<string, T> = Object.create(null);
  const f = async (...args: A) => {
    const key = memoizeKey ? memoizeKey(...args) : '__default__';
    if (!val[key]) {
      val[key] = await fn(...args);
    }
    return val[key];
  };
  (f as any).invalidate = () => {
    val = Object.create(null);
  };
  return f as any as ((...args: A) => Promise<T>) & { invalidate: () => void };
};

export const IS_DRY_RUN = !process.argv.includes('--do-it-for-real-this-time');
