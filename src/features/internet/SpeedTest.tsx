import { useState } from 'preact/hooks';
import { useSpeedTest } from '../../api/speedtest';
import type { SpeedTestResult } from '../../api/types';
import { formatBitrate } from '../../lib/format';
import { relativeTime } from '../../model/events';
import { IconArrowDown, IconArrowUp } from '../../components/icons';
import { Banner, Button, Card, Spinner, Stat } from '../../components/ui';
import { AddonCard } from '../../components/InstallAddon';

/** Bits per second in (what the plugin stores). */
export const mbps = (bits: number) => formatBitrate(bits / 8, 0);

const when = (r: SpeedTestResult) =>
  new Date(r.at * 1000).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

export function SpeedTestCard() {
  const { status, start } = useSpeedTest();
  const [error, setError] = useState<string | null>(null);
  const s = status.data;
  // No plugin (an older netui on the router): leave the card out.
  if (!s) return null;
  if (!s.available) {
    return (
      <AddonCard addon="speedtest" title="Speed test">Test the internet speed from the router, without WiFi in the way.</AddonCard>
    );
  }
  const [last, ...earlier] = s.history;
  const run = async () => {
    setError(null);
    try {
      await start();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Card
      title="Speed test"
      actions={
        <Button variant="primary" disabled={s.running} onClick={() => void run()}>
          {s.running ? (
            <>
              <Spinner /> Testing…
            </>
          ) : (
            'Run speed test'
          )}
        </Button>
      }
    >
      <div class="space-y-4">
        {s.running && (
          <p role="status" class="text-muted">
            Measuring download, then upload. This takes about 30 seconds and uses as much data as the line moves in that time.
          </p>
        )}
        {(error ?? s.error) && (
          <Banner tone="bad" role="alert">
            {error ?? s.error}
          </Banner>
        )}
        {last ? (
          <div>
            <div class="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat
                label="Download"
                value={
                  <span class="inline-flex items-center gap-1 text-accent">
                    <IconArrowDown size={16} />
                    {mbps(last.download)}
                  </span>
                }
              />
              <Stat
                label="Upload"
                value={
                  <span class="inline-flex items-center gap-1 text-violet">
                    <IconArrowUp size={16} />
                    {mbps(last.upload)}
                  </span>
                }
              />
              <Stat label="Ping" value={`${Math.round(last.ping)} ms`} />
              <Stat label="Jitter" value={`${Math.round(last.jitter)} ms`} />
            </div>
            <p class="mt-2 text-xs text-muted">
              {relativeTime(last.at * 1000, Date.now())}
              {last.server && ` · ${last.server}`}
            </p>
          </div>
        ) : (
          !s.running && (
            <p class="text-muted">
              No speed test yet. Running one measures the router's own connection, without WiFi in the way.
            </p>
          )
        )}
        {earlier.length > 0 && (
          <div class="overflow-x-auto">
            <table class="table" aria-label="Earlier speed tests">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Download</th>
                  <th>Upload</th>
                  <th>Ping</th>
                </tr>
              </thead>
              <tbody>
                {earlier.slice(0, 9).map((r) => (
                  <tr key={r.at}>
                    <td>{when(r)}</td>
                    <td class="tabular-nums">{mbps(r.download)}</td>
                    <td class="tabular-nums">{mbps(r.upload)}</td>
                    <td class="tabular-nums">{Math.round(r.ping)} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}
