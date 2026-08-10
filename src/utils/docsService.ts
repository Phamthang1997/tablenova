import type { DbEngine, DocEntry, DocSearchFilter } from '../docsData/types';
import { SQLITE_DOCS } from '../docsData/sqliteDocs';
import { MYSQL_DOCS } from '../docsData/mysqlDocs';
import { POSTGRES_DOCS } from '../docsData/postgresDocs';
import { REDIS_DOCS } from '../docsData/redisDocs';

const ALL_DOCS: DocEntry[] = [
  ...SQLITE_DOCS,
  ...MYSQL_DOCS,
  ...POSTGRES_DOCS,
  ...REDIS_DOCS,
];

// Map lookup: engine:UPPERCASE_NAME -> DocEntry
const DOC_MAP = new Map<string, DocEntry>();

// Populate fast lookup map
for (const item of ALL_DOCS) {
  const key = `${item.engine}:${item.name.toUpperCase()}`;
  DOC_MAP.set(key, item);
}

/**
 * Normalizes DB type strings used in TableNova ('postgres' | 'mysql' | 'sqlite' | 'redis')
 */
export function normalizeEngine(dbType?: string): DbEngine | undefined {
  if (!dbType) return undefined;
  const lower = dbType.toLowerCase();
  if (lower.includes('postgres') || lower.includes('pgsql')) return 'postgres';
  if (lower.includes('mysql') || lower.includes('mariadb')) return 'mysql';
  if (lower.includes('sqlite')) return 'sqlite';
  if (lower.includes('redis')) return 'redis';
  return undefined;
}

/**
 * Looks up documentation for a specific function or command.
 */
export function getDoc(name: string, dbType?: string): DocEntry | null {
  if (!name) return null;
  const cleanName = name.trim().toUpperCase().replace(/^[`"[]|[`"\]]$/g, '');
  const engine = normalizeEngine(dbType);

  if (engine) {
    const exact = DOC_MAP.get(`${engine}:${cleanName}`);
    if (exact) return exact;
  }

  // Fallback search across all engines if engine not specified or exact match missed
  for (const doc of ALL_DOCS) {
    if (doc.name.toUpperCase() === cleanName) {
      if (!engine || doc.engine === engine) {
        return doc;
      }
    }
  }

  return null;
}

/**
 * Searches documentation based on filter parameters (query, engine, category).
 */
export function searchDocs(filter: DocSearchFilter): DocEntry[] {
  const query = (filter.query || '').trim().toLowerCase();
  const targetEngine = filter.engine && filter.engine !== 'all' ? normalizeEngine(filter.engine) : undefined;
  const targetCat = filter.category && filter.category !== 'all' ? filter.category : undefined;

  return ALL_DOCS.filter((doc) => {
    if (targetEngine && doc.engine !== targetEngine) return false;
    if (targetCat && doc.category !== targetCat) return false;

    if (!query) return true;

    const nameMatch = doc.name.toLowerCase().includes(query);
    const syntaxMatch = doc.syntax.toLowerCase().includes(query);
    const summaryMatch = doc.summary.toLowerCase().includes(query);
    const descMatch = doc.description.toLowerCase().includes(query);

    return nameMatch || syntaxMatch || summaryMatch || descMatch;
  });
}

/**
 * Resolves localized summary for a doc entry.
 */
export function getDocSummary(doc: DocEntry, lang?: string): string {
  if (lang === 'vi' && doc.summaryVi) return doc.summaryVi;
  if (lang === 'ja' && doc.summaryJa) return doc.summaryJa;
  return doc.summary;
}

/**
 * Resolves localized description for a doc entry.
 */
export function getDocDescription(doc: DocEntry, lang?: string): string {
  if (lang === 'vi' && doc.descriptionVi) return doc.descriptionVi;
  if (lang === 'ja' && doc.descriptionJa) return doc.descriptionJa;
  return doc.description;
}

/**
 * Resolves localized parameter description.
 */
export function getParamDesc(param: { desc: string; descVi?: string; descJa?: string }, lang?: string): string {
  if (lang === 'vi' && param.descVi) return param.descVi;
  if (lang === 'ja' && param.descJa) return param.descJa;
  return param.desc;
}

/**
 * Formats a DocEntry into rich Markdown for Monaco Hover tooltips & doc popovers.
 */
export function formatDocMarkdown(doc: DocEntry, lang?: string): string {
  const engineName =
    doc.engine === 'mysql'
      ? 'MySQL 8.x/9.x'
      : doc.engine === 'postgres'
      ? 'PostgreSQL 14-18'
      : doc.engine === 'sqlite'
      ? 'SQLite 3.53+'
      : 'Redis 7.x/8.0+';

  const summaryText = getDocSummary(doc, lang);
  const descText = getDocDescription(doc, lang);

  const lines: string[] = [
    `**\`${doc.name}\`** · *${engineName}*`,
    `\`\`\`sql`,
    doc.syntax,
    `\`\`\``,
    `**${lang === 'vi' ? 'Tóm tắt' : lang === 'ja' ? '概要' : 'Summary'}:** ${summaryText}`,
    '',
    descText,
  ];

  if (doc.complexity) {
    lines.push('', `⏱ **${lang === 'vi' ? 'Độ phức tạp' : lang === 'ja' ? '時間複雑度' : 'Time Complexity'}:** \`${doc.complexity}\``);
  }

  if (doc.params && doc.params.length > 0) {
    lines.push('', `**${lang === 'vi' ? 'Tham số' : lang === 'ja' ? 'パラメータ' : 'Parameters'}:**`);
    for (const p of doc.params) {
      const opt = p.optional ? (lang === 'vi' ? ' *(tùy chọn)*' : lang === 'ja' ? ' *(省略可能)*' : ' *(optional)*') : '';
      const typeStr = p.type ? ` \`${p.type}\`` : '';
      lines.push(`- \`${p.name}\`${typeStr}${opt}: ${getParamDesc(p, lang)}`);
    }
  }

  if (doc.returns) {
    lines.push('', `**${lang === 'vi' ? 'Kiểu trả về' : lang === 'ja' ? '戻り値' : 'Returns'}:** \`${doc.returns}\``);
  }

  if (doc.since) {
    lines.push('', `ℹ️ **${lang === 'vi' ? 'Từ phiên bản' : lang === 'ja' ? 'サポート' : 'Since'}:** ${doc.since}`);
  }

  if (doc.examples && doc.examples.length > 0) {
    lines.push('', `**${lang === 'vi' ? 'Ví dụ' : lang === 'ja' ? '使用例' : 'Example'}:**`, '```sql', doc.examples[0], '```');
  }

  if (doc.officialUrl) {
    lines.push('', `🔗 [${lang === 'vi' ? 'Tài liệu chính thức' : lang === 'ja' ? '公式ドキュメント' : 'Official Documentation'}](${doc.officialUrl})`);
  }

  return lines.join('\n');
}

/** Returns all indexed doc entries */
export function getAllDocs(): DocEntry[] {
  return ALL_DOCS;
}
