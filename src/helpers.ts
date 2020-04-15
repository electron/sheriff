import { PayloadRepository, WebhookEvent } from '@octokit/webhooks';

export const isMainRepo = (repo: PayloadRepository) => {
  // electron/electron or foo/foo
  return repo.name === repo.owner.login;
};

type HookContext = {
  log: (...args: any[]) => void;
  error: (...args: any[]) => void;
};

export const hook = <T>(
  fn: (event: WebhookEvent<T>, context: HookContext) => Promise<void>,
): ((event: WebhookEvent<T>) => Promise<void>) => {
  return async event => {
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
): ((...args: A) => Promise<T>) & { invalidate: () => void } => {
  let val: T | null = null;
  const f = async (...args: A) => {
    if (!val) {
      val = await fn(...args);
    }
    return val;
  };
  (f as any).invalidate = () => {
    val = null;
  };
  return f as any;
};

export const IS_DRY_RUN = !process.argv.includes('--do-it-for-real-this-time');
