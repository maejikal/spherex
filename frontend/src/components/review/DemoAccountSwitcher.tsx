import { useId } from 'react';
import { DEMO_ACCOUNTS } from '../../review/accounts.ts';

export function DemoAccountSwitcher({ identity, onChange, compact = false }: { identity: string; onChange: (id: string) => void; compact?: boolean }) {
  const id = useId();
  return <div className={`demo-account${compact ? ' demo-account--compact' : ''}`}>
    <label htmlFor={id}>Demo account{!compact && ' · no sign-in'}</label>
    <select id={id} value={identity} onChange={(event) => onChange(event.target.value)}>
      {DEMO_ACCOUNTS.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
    </select>
  </div>;
}
