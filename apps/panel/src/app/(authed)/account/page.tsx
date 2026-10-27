import { redirect } from 'next/navigation';

export default function AccountIndex(): never {
  redirect('/account/security');
}
