import { Card, Detail } from '../../components/ui';

const REPO = 'https://github.com/msjonker/netui';

function Link({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" class="text-accent hover:underline">
      {children}
    </a>
  );
}

/** Version, author, license and where to report problems. */
export function AboutCard() {
  return (
    <Card title="About netui">
      <Detail
        rows={[
          ['Version', __NETUI_VERSION__],
          ['Made by', 'Matt Jonker'],
          ['License', <Link href={`${REPO}/blob/main/LICENSE`}>MIT License</Link>],
          ['Source code', <Link href={REPO}>github.com/msjonker/netui</Link>],
        ]}
      />
      <p class="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-3 text-xs">
        <Link href={`${REPO}/issues`}>Report a problem</Link>
        {/* Written next to index.html by the build (vite.config.ts). */}
        <Link href="licenses.txt">Third-party licenses</Link>
      </p>
    </Card>
  );
}
