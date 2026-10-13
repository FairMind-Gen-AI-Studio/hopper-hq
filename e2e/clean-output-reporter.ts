import type { FullConfig, Reporter } from '@playwright/test/reporter';
import { cleanOutputAfterPass } from './output.js';

/**
 * Clears the run's output when it passed; keeps the screenshot and error context of a failed one. It runs in onExit
 * because Playwright writes `.last-run.json` only after the run's global teardown.
 */
export default class CleanOutputReporter implements Reporter {
  private outputDir: string | undefined;

  onBegin(config: FullConfig): void {
    this.outputDir = config.projects[0]?.outputDir;
  }

  async onExit(): Promise<void> {
    if (this.outputDir) await cleanOutputAfterPass(this.outputDir);
  }
}
