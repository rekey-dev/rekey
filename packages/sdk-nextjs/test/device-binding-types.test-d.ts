/**
 * The half of the device-binding bug that only a type checker can see.
 *
 * `signIn` declared its input as exactly `{ email: string; password: string }`.
 * At runtime a `device` key would have been forwarded by the spread regardless,
 * so no runtime test can fail on it: the refusal happened in the caller's own
 * file, as "Object literal may only specify known properties". Against an
 * Application with `deviceBinding: 'required'` that made sign-in through this
 * SDK impossible, and the error pointed at the app rather than at the SDK.
 *
 * This file is type-checked by `tsconfig.test.json` and deliberately NOT run by
 * vitest (its name does not match the runner's `*.test.ts` glob). Revert the
 * widened inputs in `src/server.ts` and `pnpm --filter @rekey.dev/nextjs
 * typecheck` fails here.
 */
import { signIn, signUp, mfaVerify, auth, refreshSession } from '../src/server.js';
import type { DeviceBindingRequest, SignInFailure } from '../src/server.js';

const device: DeviceBindingRequest = { fingerprint: 'sha256:aaaaaaaaaaaa', label: 'Work laptop' };

export async function everySessionMinterAcceptsADevice(): Promise<void> {
  await signIn({ email: 'a@b.c', password: 'pw', device });
  await signUp({ email: 'a@b.c', password: 'pw', device });
  await signUp({ email: 'a@b.c', password: 'pw', metadata: { plan: 'pro' }, device });
  await mfaVerify({ mfaChallengeToken: 'ch', code: '123456', device });
  await auth({ device });
  await refreshSession({ device });
}

/** The existing signatures keep working for callers that pass nothing. */
export async function theOldCallsStillCompile(): Promise<void> {
  await signIn({ email: 'a@b.c', password: 'pw' });
  await signUp({ email: 'a@b.c', password: 'pw' });
  await mfaVerify({ mfaChallengeToken: 'ch', code: '123456' });
  await auth();
  await refreshSession();
}

/** A label-only or malformed binding stays a compile error. */
export async function aMalformedDeviceIsStillRefused(): Promise<void> {
  // @ts-expect-error fingerprint is a string, and it is the required half.
  await signIn({ email: 'a@b.c', password: 'pw', device: { fingerprint: 123 } });
  // @ts-expect-error a label alone identifies no machine.
  await signIn({ email: 'a@b.c', password: 'pw', device: { label: 'Work laptop' } });
}

/** The failure union is exhaustive, so a new arm breaks a caller loudly. */
export function everyFailureArmIsNamed(failure: SignInFailure): string {
  switch (failure.kind) {
    case 'invalid_credentials':
      return 'wrong password';
    case 'device_required':
      return 'send a fingerprint';
    case 'device_limit':
      return `release one of ${failure.devices.length}`;
    case 'device_blocked':
      return 'ask an operator';
    case 'retry_later':
      return `wait ${failure.retryAfterSeconds ?? 5}s`;
    case 'other':
      return failure.code;
  }
}
