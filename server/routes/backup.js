/**
 * 备份导出 / 导入（M5）。
 *
 * GET  /api/backup/export?studentId=   → JSON 下载（可选单个学生）
 * POST /api/backup/preview             → {data} 校验并返回摘要 + 同名同校冲突清单
 * POST /api/backup/import              → {data, conflict?, decisions?, confirm_overwrite?}
 */
import { badRequest, parseOrThrow } from '../lib/errors.js';
import {
  buildBackup,
  importBackup,
  previewBackup,
  snapshotBeforeImport,
} from '../lib/backup.js';
import { formatShanghaiDate } from '../lib/time.js';
import {
  backupExportQuerySchema,
  backupImportSchema,
  backupPreviewSchema,
} from '../lib/schemas.js';

export default async function backupRoutes(app) {
  const auth = { preHandler: app.authenticate };

  app.get('/backup/export', auth, async (req, reply) => {
    const query = parseOrThrow(backupExportQuerySchema, req.query ?? {}, '导出参数');
    const payload = buildBackup(app.students, { studentId: query.studentId });
    const filename = `student-status-board-${formatShanghaiDate(Date.now())}.json`;
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    reply.type('application/json; charset=utf-8');
    return payload;
  });

  app.post('/backup/preview', auth, async (req) => {
    const payload = parseOrThrow(backupPreviewSchema, req.body, '预览参数');
    if (payload.data === undefined) {
      throw badRequest('缺少 data', 'INVALID_BACKUP');
    }
    return { ok: true, ...previewBackup(app.db, payload.data) };
  });

  app.post('/backup/import', auth, async (req) => {
    const payload = parseOrThrow(backupImportSchema, req.body, '导入参数');
    if (payload.data === undefined) {
      throw badRequest('缺少 data', 'INVALID_BACKUP');
    }

    // 先完整校验一遍：文件不合法就不生成快照、也不碰数据
    previewBackup(app.db, payload.data);

    // 覆盖前先给当前库留一份快照；快照失败直接中止，不带风险写入
    const backupFile = await snapshotBeforeImport(app.db, app.cfg);

    const stats = importBackup({
      db: app.db,
      data: payload.data,
      conflict: payload.conflict ?? 'new',
      decisions: payload.decisions,
      confirmOverwrite: payload.confirm_overwrite === true,
    });
    return {
      ok: true,
      ...stats,
      backup_file: backupFile ? `data/backups/${backupFile.split(/[\\/]/).pop()}` : null,
    };
  });
}
