/** One line of the `rekey doctor` report. */

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skipped';

export interface Check {
  name: string;
  /** `skipped` is a check that did not run, usually for want of a credential. It is not a pass. */
  status: CheckStatus;
  message: string;
  /** What to do about it. Present on every check that is not `ok`. */
  fix?: string;
  /** The Application the check is about. Absent on a check of the deployment or of the CLI's own configuration. */
  applicationId?: string;
}

/** What a money check concludes, before the Application it is about is attached. */
export type Finding = Omit<Check, 'name' | 'applicationId'>;
