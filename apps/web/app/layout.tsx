import type { Metadata } from 'next';
import './globals.css';
import { Nav } from './nav.tsx';
import { db, currentUserId } from '../lib/db.ts';
import * as repo from '@studyos/db';

export const metadata: Metadata = {
  title: 'StudyOS',
  description: 'Local-first study, revision and productivity operating system',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const cards = repo.listRevisionCards(db(), currentUserId());
  const now = Date.now();
  const dueCount = cards.filter((c) => c.state.dueAt <= now).length;

  return (
    <html lang="en">
      <body>
        <div className="flex min-h-screen">
          <aside
            className="hidden w-60 shrink-0 flex-col gap-6 border-r p-5 md:flex"
            style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}
          >
            <div>
              <div className="text-base font-semibold tracking-tight">StudyOS</div>
              <div className="text-xs dim mt-0.5">local-first · offline</div>
            </div>
            <Nav dueCount={dueCount} />
            <div className="mt-auto text-[11px] dim leading-relaxed">
              Numbers are labelled by where they came from:
              <span className="prov prov-measured ml-1">measured</span>{' '}
              <span className="prov prov-inferred">estimated</span>{' '}
              <span className="prov prov-demonstrated">demonstrated</span>
            </div>
          </aside>
          <main className="min-w-0 flex-1">
            <div
              className="border-b px-3 py-2 md:hidden"
              style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}
            >
              <Nav dueCount={dueCount} orientation="horizontal" />
            </div>
            <div className="mx-auto max-w-6xl p-5 md:p-8">{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}
