export type DbEngine = 'mysql' | 'postgres' | 'sqlite' | 'redis';

export type DocCategory =
  | 'string'
  | 'datetime'
  | 'json'
  | 'aggregate'
  | 'window'
  | 'math'
  | 'control_flow'
  | 'spatial_vector'
  | 'dml'
  | 'ddl'
  | 'transaction'
  | 'command'
  | 'pragma';

export interface ParamDoc {
  name: string;
  type?: string;
  optional?: boolean;
  desc: string;
  descVi?: string;
  descJa?: string;
}

export interface DocEntry {
  id: string;                      // Unique ID, e.g. "mysql:json_extract"
  name: string;                    // Function or command name in UPPERCASE (e.g. "JSON_EXTRACT", "XADD")
  engine: DbEngine;
  category: DocCategory;
  syntax: string;                  // e.g. "JSON_EXTRACT(json_doc, path[, path]...)"
  summary: string;                 // Short description (English default)
  summaryVi?: string;              // Short description in Vietnamese
  summaryJa?: string;              // Short description in Japanese
  description: string;             // Detailed markdown explanation (English default)
  descriptionVi?: string;          // Detailed explanation in Vietnamese
  descriptionJa?: string;          // Detailed explanation in Japanese
  params?: ParamDoc[];
  returns?: string;                // Return type (e.g. "JSON", "VARCHAR", "INTEGER")
  complexity?: string;             // Time complexity for Redis commands (e.g. "O(1)")
  since?: string;                  // Min version (e.g. "MySQL 8.0", "Redis 5.0.0", "SQLite 3.38")
  examples: string[];              // Code snippet examples
  officialUrl?: string;            // Official reference URL
}

export interface DocSearchFilter {
  query?: string;
  engine?: DbEngine | 'all';
  category?: DocCategory | 'all';
}
