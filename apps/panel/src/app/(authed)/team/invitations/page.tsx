import { redirect } from 'next/navigation';

/** Invitations now live in the People list; old links and bookmarks land there. */
export default function TeamInvitationsPage(): never {
  redirect('/team');
}
