export interface ExplainNode {
  id: string;
  type: string;
  table?: string;
  indexName?: string;
  cost?: { start: number; total: number };
  costSeverity?: 'low' | 'medium' | 'high';
  rows?: number;
  actualTime?: { start: number; total: number };
  actualRows?: number;
  filter?: string;
  joinFilter?: string;
  hashCond?: string;
  details?: Record<string, any>;
  children?: ExplainNode[];
}

export interface ExplainResult {
  rawText: string;
  rootNode: ExplainNode | null;
  planningTimeMs?: number;
  executionTimeMs?: number;
}

export function buildExplainQuery(sql: string, dbType: string, variant: 'explain' | 'analyze' | 'json' = 'explain'): string {
  const cleanSql = sql.trim().replace(/;$/, '');
  const db = (dbType || 'mysql').toLowerCase();

  if (db.includes('postgres') || db.includes('pg')) {
    if (variant === 'analyze') {
      return `EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS) ${cleanSql};`;
    }
    return `EXPLAIN (FORMAT JSON) ${cleanSql};`;
  }

  if (db.includes('mysql') || db.includes('maria')) {
    if (variant === 'json') {
      return `EXPLAIN FORMAT=JSON ${cleanSql};`;
    }
    if (variant === 'analyze') {
      return `EXPLAIN ANALYZE ${cleanSql};`;
    }
    return `EXPLAIN ${cleanSql};`;
  }

  if (db.includes('sqlite')) {
    return `EXPLAIN QUERY PLAN ${cleanSql};`;
  }

  return `EXPLAIN ${cleanSql};`;
}

let nodeCounter = 0;

export function parseExplainOutput(rows: any[], dbType: string): ExplainResult {
  nodeCounter = 0;
  const db = (dbType || 'mysql').toLowerCase();

  if (!rows || rows.length === 0) {
    return { rawText: 'Không có dữ liệu EXPLAIN.', rootNode: null };
  }

  // Build raw text from rows
  const rawText = rows.map(r => {
    if (typeof r === 'string') return r;
    if (r && typeof r === 'object') {
      const val = r['EXPLAIN'] || r['explain'] || r['QUERY PLAN'] || r['EXPLAIN ANALYZE'] || Object.values(r)[0];
      return typeof val === 'string' ? val : JSON.stringify(val);
    }
    return String(r);
  }).join('\n');

  // Text-based EXPLAIN ANALYZE format (MySQL 8+ "-> Table scan..." or PostgreSQL text plan)
  if (rawText.includes('->') || rawText.includes('actual time=')) {
    const textNode = parseAnalyzeTextPlan(rawText);
    if (textNode) {
      return {
        rawText,
        rootNode: textNode
      };
    }
  }

  // Format Postgres JSON
  if (db.includes('postgres') || db.includes('pg')) {
    try {
      let pgData = rows[0];
      if (typeof pgData === 'object') {
        const firstKey = Object.keys(pgData)[0];
        if (typeof pgData[firstKey] === 'string' && pgData[firstKey].trim().startsWith('[')) {
          pgData = JSON.parse(pgData[firstKey]);
        } else if (pgData['QUERY PLAN']) {
          pgData = typeof pgData['QUERY PLAN'] === 'string' ? JSON.parse(pgData['QUERY PLAN']) : pgData['QUERY PLAN'];
        }
      }
      if (Array.isArray(pgData)) pgData = pgData[0];

      if (pgData && pgData.Plan) {
        const rootNode = parsePgNode(pgData.Plan);
        return {
          rawText: JSON.stringify(pgData, null, 2),
          rootNode,
          planningTimeMs: pgData['Planning Time'],
          executionTimeMs: pgData['Execution Time']
        };
      }
    } catch {
      // fallback to raw text
    }
  }

  // Format MySQL (JSON or Tabular)
  if (db.includes('mysql') || db.includes('maria') || (rows[0] && ('select_type' in rows[0] || 'SELECT_TYPE' in rows[0]))) {
    try {
      let jsonStr = '';
      const firstRow = rows[0];
      if (firstRow) {
        jsonStr = firstRow['EXPLAIN'] || firstRow['explain'] || firstRow['QUERY PLAN'] || (typeof Object.values(firstRow)[0] === 'string' ? Object.values(firstRow)[0] as string : '');
      }
      if (jsonStr && typeof jsonStr === 'string' && jsonStr.trim().startsWith('{')) {
        const mysqlData = JSON.parse(jsonStr);
        const rootNode = parseMysqlJsonNode(mysqlData.query_block || mysqlData);
        return {
          rawText: JSON.stringify(mysqlData, null, 2),
          rootNode
        };
      }

      // MySQL Tabular EXPLAIN format (id, select_type, table, type, possible_keys, key, rows, Extra)
      if (firstRow && ('select_type' in firstRow || 'SELECT_TYPE' in firstRow || 'table' in firstRow || 'TABLE' in firstRow)) {
        const rootNode = parseMysqlTabularPlan(rows);
        return {
          rawText: rows.map(r => Object.entries(r).map(([k, v]) => `${k}: ${v}`).join(' | ')).join('\n'),
          rootNode
        };
      }
    } catch {
      // fallback
    }
  }

  // Format SQLite EXPLAIN QUERY PLAN
  if (db.includes('sqlite') || (rows[0] && ('detail' in rows[0] || 'DETAIL' in rows[0] || 'selectid' in rows[0]))) {
    const rootNode = parseSqlitePlan(rows);
    return { rawText, rootNode };
  }

  // Fallback Raw Text & Generic Node
  return {
    rawText,
    rootNode: {
      id: 'node_1',
      type: 'Execute Query',
      details: { raw: rawText }
    }
  };
}

function parseAnalyzeTextPlan(rawText: string): ExplainNode | null {
  const lines = rawText.split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.trim().length > 0);
  if (lines.length === 0) return null;

  interface StackItem {
    indent: number;
    node: ExplainNode;
  }

  const stack: StackItem[] = [];
  let rootNode: ExplainNode | null = null;

  lines.forEach((line) => {
    const arrowIdx = line.indexOf('->');
    let indent = 0;
    let content = line;
    if (arrowIdx !== -1) {
      indent = arrowIdx;
      content = line.substring(arrowIdx + 2).trim();
    } else {
      indent = line.search(/\S/);
      if (indent === -1) indent = 0;
      content = line.trim();
    }

    let cost: { start: number; total: number } | undefined;
    let rows: number | undefined;
    const costMatch = content.match(/\(cost=([\d.]+)(?:\.\.([\d.]+))?\s+rows=(\d+)\)/i);
    if (costMatch) {
      const startCost = costMatch[2] ? parseFloat(costMatch[1]) : 0;
      const totalCost = costMatch[2] ? parseFloat(costMatch[2]) : parseFloat(costMatch[1]);
      cost = { start: startCost, total: totalCost };
      rows = parseInt(costMatch[3], 10);
    }

    let actualTime: { start: number; total: number } | undefined;
    let actualRows: number | undefined;
    const actualMatch = content.match(/\(actual time=([\d.]+)\.\.([\d.]+)\s+rows=(\d+)/i);
    if (actualMatch) {
      actualTime = { start: parseFloat(actualMatch[1]), total: parseFloat(actualMatch[2]) };
      actualRows = parseInt(actualMatch[3], 10);
    }

    let opTitle = content
      .replace(/\(cost=.*?\)/gi, '')
      .replace(/\(actual time=.*?\)/gi, '')
      .trim();

    if (!opTitle) opTitle = 'Operation';

    const tableMatch = opTitle.match(/(?:on|from)\s+([`"\w]+)/i);
    const table = tableMatch ? tableMatch[1].replace(/[`"]/g, '') : undefined;

    const indexMatch = opTitle.match(/using\s+([`"\w]+)/i);
    const indexName = indexMatch ? indexMatch[1].replace(/[`"]/g, '') : undefined;

    const titleUpper = opTitle.toUpperCase();
    let costSeverity: 'low' | 'medium' | 'high' = 'low';
    if (titleUpper.includes('TABLE SCAN') || titleUpper.includes('SEQ SCAN') || titleUpper.includes('FULL SCAN')) {
      costSeverity = 'high';
    } else if (titleUpper.includes('INDEX SCAN') || titleUpper.includes('RANGE SCAN') || titleUpper.includes('FILESORT')) {
      costSeverity = 'medium';
    } else if (cost && cost.total > 100) {
      costSeverity = 'high';
    } else if (cost && cost.total > 10) {
      costSeverity = 'medium';
    }

    nodeCounter++;
    const node: ExplainNode = {
      id: `analyze_${nodeCounter}_${Date.now()}`,
      type: opTitle,
      table,
      indexName,
      cost,
      costSeverity,
      rows,
      actualTime,
      actualRows,
      details: { rawLine: line }
    };

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    if (stack.length > 0) {
      const parent = stack[stack.length - 1].node;
      if (!parent.children) parent.children = [];
      parent.children.push(node);
    } else {
      if (!rootNode) rootNode = node;
    }

    stack.push({ indent, node });
  });

  return rootNode;
}

function parsePgNode(plan: any): ExplainNode {
  nodeCounter++;
  const node: ExplainNode = {
    id: `pg_${nodeCounter}_${Date.now()}`,
    type: plan['Node Type'] || 'Operation',
    table: plan['Relation Name'] || plan['Alias'],
    indexName: plan['Index Name'],
    cost: plan['Startup Cost'] !== undefined ? { start: plan['Startup Cost'], total: plan['Total Cost'] } : undefined,
    rows: plan['Plan Rows'],
    actualTime: plan['Actual Startup Time'] !== undefined ? { start: plan['Actual Startup Time'], total: plan['Actual Total Time'] } : undefined,
    actualRows: plan['Actual Rows'],
    filter: plan['Filter'],
    joinFilter: plan['Join Filter'],
    hashCond: plan['Hash Cond'],
    details: { ...plan }
  };

  if (plan.Plans && Array.isArray(plan.Plans)) {
    node.children = plan.Plans.map((child: any) => parsePgNode(child));
  }

  return node;
}

function parseMysqlTabularPlan(rows: any[]): ExplainNode {
  nodeCounter++;
  const children: ExplainNode[] = rows.map((row, index) => {
    const accessType = (row.type || row.TYPE || 'SCAN').toUpperCase();
    const isFullScan = accessType === 'ALL';
    const isIndexScan = accessType === 'INDEX' || accessType === 'RANGE';
    const severity = isFullScan ? 'high' : (isIndexScan ? 'medium' : 'low');
    const table = row.table || row.TABLE;
    const key = row.key || row.KEY || row.possible_keys || row.POSSIBLE_KEYS;
    const extra = row.Extra || row.EXTRA;

    return {
      id: `mysql_tab_${index}_${Date.now()}`,
      type: `${row.select_type || row.SELECT_TYPE || 'SIMPLE'} [${accessType}]`,
      table,
      indexName: key,
      costSeverity: severity,
      rows: row.rows ? parseInt(row.rows, 10) : (row.ROWS ? parseInt(row.ROWS, 10) : undefined),
      filter: extra ? String(extra) : undefined,
      details: { ...row }
    };
  });

  if (children.length === 1) {
    return children[0];
  }

  return {
    id: `mysql_root_${Date.now()}`,
    type: 'Query Execution Plan',
    children
  };
}

function parseMysqlJsonNode(obj: any): ExplainNode {
  nodeCounter++;
  const id = `mysql_json_${nodeCounter}_${Date.now()}`;

  if (!obj) {
    return { id, type: 'Operation' };
  }

  if (obj.query_block) {
    return parseMysqlJsonNode(obj.query_block);
  }

  if (obj.ordering_operation) {
    const child = parseMysqlJsonNode(obj.ordering_operation);
    return {
      id,
      type: 'Sort (Filesort)',
      cost: obj.cost_info?.query_cost ? { start: 0, total: parseFloat(obj.cost_info.query_cost) } : child.cost,
      children: [child],
      details: { ...obj }
    };
  }

  if (obj.grouping_operation) {
    const child = parseMysqlJsonNode(obj.grouping_operation);
    return {
      id,
      type: 'Group By',
      cost: obj.cost_info?.query_cost ? { start: 0, total: parseFloat(obj.cost_info.query_cost) } : child.cost,
      children: [child],
      details: { ...obj }
    };
  }

  if (obj.nested_loop && Array.isArray(obj.nested_loop)) {
    const children = obj.nested_loop.map((item: any) => parseMysqlJsonNode(item));
    return {
      id,
      type: 'Nested Loop Join',
      cost: obj.cost_info?.query_cost ? { start: 0, total: parseFloat(obj.cost_info.query_cost) } : undefined,
      children,
      details: { ...obj }
    };
  }

  if (obj.table) {
    const t = obj.table;
    const accessType = (t.access_type || 'scan').toUpperCase();
    const isFullScan = accessType === 'ALL';
    const isIndexScan = accessType === 'INDEX' || accessType === 'RANGE';

    return {
      id,
      type: `${t.table_name || 'Table'} [${accessType}]`,
      table: t.table_name,
      indexName: t.key || (t.possible_keys ? t.possible_keys.join(', ') : undefined),
      cost: t.cost_info?.read_cost !== undefined
        ? { start: parseFloat(t.cost_info.read_cost || '0'), total: parseFloat(t.cost_info.prefix_cost || t.cost_info.read_cost || '0') }
        : (obj.cost_info?.query_cost ? { start: 0, total: parseFloat(obj.cost_info.query_cost) } : undefined),
      costSeverity: isFullScan ? 'high' : (isIndexScan ? 'medium' : 'low'),
      rows: t.rows_examined_per_scan ? parseInt(t.rows_examined_per_scan, 10) : undefined,
      filter: t.attached_condition || t.filter,
      details: { ...t }
    };
  }

  return {
    id,
    type: obj.select_id ? `Select #${obj.select_id}` : 'Operation',
    cost: obj.cost_info?.query_cost ? { start: 0, total: parseFloat(obj.cost_info.query_cost) } : undefined,
    details: { ...obj }
  };
}

function parseSqlitePlan(rows: any[]): ExplainNode {
  const root: ExplainNode = {
    id: 'sqlite_root',
    type: 'Query Execution Plan',
    children: []
  };

  rows.forEach((r, idx) => {
    const detail = r.detail || r.DETAIL || Object.values(r)[3] || Object.values(r)[0];
    const detailStr = String(detail || `Step ${idx + 1}`);

    let opType = 'Scan';
    if (detailStr.includes('SEARCH')) opType = 'Index Search';
    else if (detailStr.includes('SCAN')) opType = 'Table Scan';
    else if (detailStr.includes('USE TEMP B-TREE')) opType = 'Temp B-Tree Sort';

    root.children?.push({
      id: `sqlite_${idx}`,
      type: opType,
      filter: detailStr,
      details: { ...r }
    });
  });

  return root;
}
