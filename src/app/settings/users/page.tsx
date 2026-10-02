import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { listUsers } from '@/server/accounting/masters';
import { ROLE_CAPS, FINANCE_CAPS, titleise } from '@/lib/accounting';
import {
  PageHeader, Card, Banner, Table, Th, Td, Chip,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Who may do what.
 *
 * The matrix is generated from ROLE_CAPS rather than typed out, so it cannot
 * drift from what the server actually enforces — a permissions page that
 * disagrees with the code is worse than none, because it is believed.
 *
 * Users themselves come from the CRM in production: this product is the
 * finance branch of TripzoCRM, not a second place to administer staff, and
 * two sources of "who works here" is how a leaver keeps their access. The
 * table is therefore a read of what the CRM says.
 */
export default async function UsersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const m = await msg(await searchParams);
  const users = await listUsers(s.orgId);
  const roles = Object.keys(ROLE_CAPS).filter((r) => r !== 'service_role');

  return (
    <>
      <PageHeader
        title="Users & Roles"
        subtitle="Enforced on the server, on every action — not by hiding buttons."
        accent="var(--color-sec-settings)"
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}

      <Card title="Users" padded={false}>
        <Table>
          <thead><tr><Th>Name</Th><Th>Email</Th><Th>Role</Th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="hover:bg-canvas">
                <Td>
                  <span className="font-semibold">{u.name}</span>
                  {u.id === s.userId && <span className="ml-2"><Chip state="posted" label="You" /></span>}
                </Td>
                <Td><span className="text-ink-muted">{u.email ?? '—'}</span></Td>
                <Td><Chip state="draft" label={titleise(u.role)} /></Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="px-5 py-4 text-[12.5px] text-ink-faint">
          Users and roles come from the CRM in production — this product does not administer staff, so
          a leaver removed there loses access here. Set <code>TRIPZO_USER</code> to an email in
          development to see the product as that role.
        </p>
      </Card>

      <Card title="Finance permissions" className="mt-5" padded={false}
        subtitle="Generated from the capability table the server checks, so it cannot drift from it.">
        <Table>
          <thead>
            <tr>
              <Th>Capability</Th>
              {roles.map((r) => <Th key={r} align="center">{titleise(r)}</Th>)}
            </tr>
          </thead>
          <tbody>
            {FINANCE_CAPS.map((cap) => (
              <tr key={cap} className="hover:bg-canvas">
                <Td><span className="font-semibold">{cap}</span></Td>
                {roles.map((r) => (
                  <Td key={r} align="center">
                    {ROLE_CAPS[r].includes(cap)
                      ? <span className="font-bold text-positive">✓</span>
                      : <span className="text-ink-faint">·</span>}
                  </Td>
                ))}
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </>
  );
}
