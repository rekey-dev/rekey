/**
 * Words about the machines on a licence.
 *
 * Pure and runtime-neutral: the page, the action and tests import it.
 */

export const MACHINE_REMOVED = 'machine_removed';
/** The portal's own code for a revoked or expired licence, which has no seat to give back. */
export const LICENSE_INACTIVE = 'license_inactive';

const ERRORS: Readonly<Record<string, string>> = {
  [LICENSE_INACTIVE]: 'That license is revoked or expired, so it has no seats to free.',
  LICENSE_NOT_FOUND: 'That license is no longer yours to manage. Reload the page.',
  LICENSE_ACTIVATION_NOT_FOUND: 'That machine is no longer on the license. Reload the page.',
  ORGANIZATION_ROLE_INSUFFICIENT: "Only an owner or admin of the license's organization can remove its machines.",
  ORGANIZATION_ROLE_DISABLED: 'Your role in that organization has been turned off.',
};

export function licenseMachineErrorCopy(code: string): string {
  if (Object.prototype.hasOwnProperty.call(ERRORS, code)) return ERRORS[code]!;
  return 'That did not work. Try again, and if it keeps happening, contact support.';
}

/** A machine as the customer reads it: its label, else the start of its fingerprint. */
export function machineName(machine: { label: string | null; fingerprintHint: string }): string {
  return machine.label ?? `Machine ${machine.fingerprintHint}`;
}

/**
 * @example
 * seatsLine(2, 5); // '2 of 5 seats in use'
 * seatsLine(1, null); // '1 machine in use'
 */
export function seatsLine(inUse: number, seatsAllowed: number | null): string {
  if (seatsAllowed !== null) return `${inUse} of ${seatsAllowed} ${seatsAllowed === 1 ? 'seat' : 'seats'} in use`;
  return `${inUse} ${inUse === 1 ? 'machine' : 'machines'} in use`;
}
