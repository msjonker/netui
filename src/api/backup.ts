// Config backup and restore, as LuCI does it: cgi-io streams the backup and
// takes the upload; `sysupgrade --restore-backup` (the one command line the
// ACL allows) unpacks it. The router must restart afterwards.

import { call, cgiBackup, cgiUpload } from './ubus';

/** The only path the ACL lets netui write and restore from. */
export const BACKUP_PATH = '/tmp/backup.tar.gz';

export const downloadBackup = () => cgiBackup();

export async function restoreBackup(file: Blob): Promise<void> {
  await cgiUpload(BACKUP_PATH, file);
  const r = await call<{ code?: number; stderr?: string }>(
    'file',
    'exec',
    { command: '/sbin/sysupgrade', params: ['--restore-backup', BACKUP_PATH] },
    { permissionDeniedIsAuth: false, timeoutMs: 60_000 },
  );
  if (r?.code) throw new Error(`The router could not unpack the backup: ${r.stderr?.trim() || `exit ${r.code}`}`);
}
