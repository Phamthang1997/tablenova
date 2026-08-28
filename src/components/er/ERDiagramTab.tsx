import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import { dbHelper } from '../../utils/dbHelper';
import type { ERTable, ERRelationship, ERColumn } from './erTypes';
import { ERDiagramView } from './ERDiagramView';

interface ERDiagramTabProps {
  connId: string;
  dbName?: string;
  schema?: string;
  onOpenTable?: (tableName: string) => void;
}

export const ERDiagramTab: React.FC<ERDiagramTabProps> = ({
  connId,
  dbName,
  schema,
  onOpenTable,
}) => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tables, setTables] = useState<ERTable[]>([]);
  const [relationships, setRelationships] = useState<ERRelationship[]>([]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // 1. Try getFullCatalog first (MySQL/Postgres)
      const fullCatalog = await dbHelper.getFullCatalog(connId);
      const rawCols = fullCatalog.columns || {};
      const rawFks = fullCatalog.foreignKeys || {};

      const tableNames = Object.keys(rawCols);

      // 2. Fallback to getTables + getTableSchema (for SQLite or empty catalog)
      if (tableNames.length === 0) {
        const dbTables = await dbHelper.getTables(connId);
        const schemaPromises = dbTables.map(async (tbl) => {
          try {
            const sch = await dbHelper.getTableSchema(connId, tbl.name);
            return { name: tbl.name, type: tbl.type || 'table', schema: sch };
          } catch {
            return { name: tbl.name, type: tbl.type || 'table', schema: null };
          }
        });

        const resolved = await Promise.all(schemaPromises);
        const parsedTables: ERTable[] = [];
        const parsedRels: ERRelationship[] = [];

        resolved.forEach((item) => {
          if (!item.schema) return;
          const cols: ERColumn[] = (item.schema.columns || []).map((col) => {
            const isPk = !!col.isPrimaryKey;
            const fkItem = (item.schema?.foreignKeys || []).find((fk) => fk.column === col.name);
            return {
              name: col.name,
              type: col.type,
              isPrimaryKey: isPk,
              isForeignKey: !!fkItem,
              refTable: fkItem?.refTable,
              refColumn: fkItem?.refColumn,
              nullable: col.nullable,
            };
          });

          parsedTables.push({
            id: item.name,
            name: item.name,
            kind: item.type === 'view' ? 'view' : 'table',
            columns: cols,
          });

          (item.schema.foreignKeys || []).forEach((fk) => {
            parsedRels.push({
              id: `${item.name}.${fk.column}->${fk.refTable}.${fk.refColumn || fk.column}`,
              name: fk.name,
              sourceTable: item.name,
              sourceColumn: fk.column,
              targetTable: fk.refTable,
              targetColumn: fk.refColumn || fk.column,
            });
          });
        });

        setTables(parsedTables);
        setRelationships(parsedRels);
      } else {
        // Parse from fullCatalog
        const parsedTables: ERTable[] = [];
        const parsedRels: ERRelationship[] = [];

        tableNames.forEach((tableName) => {
          const colList = rawCols[tableName] || [];
          const cols: ERColumn[] = colList.map((col: any) => ({
            name: col.name,
            type: col.type,
            isPrimaryKey: !!col.isPrimaryKey,
            isForeignKey: false,
            nullable: col.nullable,
          }));

          const tableFks = rawFks[tableName] || [];
          tableFks.forEach((fk: any) => {
            const matchingCol = cols.find((c) => c.name.toLowerCase() === (fk.column || '').toLowerCase());
            if (matchingCol) {
              matchingCol.isForeignKey = true;
              matchingCol.refTable = fk.refTable;
              matchingCol.refColumn = fk.refColumn;
            }

            parsedRels.push({
              id: `${tableName}.${fk.column}->${fk.refTable}.${fk.refColumn || fk.column}`,
              name: fk.name,
              sourceTable: tableName,
              sourceColumn: fk.column,
              targetTable: fk.refTable,
              targetColumn: fk.refColumn || fk.column,
            });
          });

          parsedTables.push({
            id: tableName,
            name: tableName,
            columns: cols,
          });
        });

        setTables(parsedTables);
        setRelationships(parsedRels);
      }
    } catch (err: any) {
      console.error('Failed to load ER diagram data:', err);
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [connId]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const fullCatalog = await dbHelper.getFullCatalog(connId);
        if (!active) return;
        const rawCols = fullCatalog.columns || {};
        const rawFks = fullCatalog.foreignKeys || {};
        const tableNames = Object.keys(rawCols);

        if (tableNames.length === 0) {
          const dbTables = await dbHelper.getTables(connId);
          if (!active) return;
          const schemaPromises = dbTables.map(async (tbl) => {
            try {
              const sch = await dbHelper.getTableSchema(connId, tbl.name);
              return { name: tbl.name, type: tbl.type || 'table', schema: sch };
            } catch {
              return { name: tbl.name, type: tbl.type || 'table', schema: null };
            }
          });

          const resolved = await Promise.all(schemaPromises);
          if (!active) return;
          const parsedTables: ERTable[] = [];
          const parsedRels: ERRelationship[] = [];

          resolved.forEach((item) => {
            if (!item.schema) return;
            const cols: ERColumn[] = (item.schema.columns || []).map((col) => {
              const isPk = !!col.isPrimaryKey;
              const fkItem = (item.schema?.foreignKeys || []).find((fk) => fk.column === col.name);
              return {
                name: col.name,
                type: col.type,
                isPrimaryKey: isPk,
                isForeignKey: !!fkItem,
                refTable: fkItem?.refTable,
                refColumn: fkItem?.refColumn,
                nullable: col.nullable,
              };
            });

            parsedTables.push({
              id: item.name,
              name: item.name,
              kind: item.type === 'view' ? 'view' : 'table',
              columns: cols,
            });

            (item.schema.foreignKeys || []).forEach((fk) => {
              parsedRels.push({
                id: `${item.name}.${fk.column}->${fk.refTable}.${fk.refColumn || fk.column}`,
                name: fk.name,
                sourceTable: item.name,
                sourceColumn: fk.column,
                targetTable: fk.refTable,
                targetColumn: fk.refColumn || fk.column,
              });
            });
          });

          setTables(parsedTables);
          setRelationships(parsedRels);
        } else {
          const parsedTables: ERTable[] = [];
          const parsedRels: ERRelationship[] = [];

          tableNames.forEach((tableName) => {
            const colList = rawCols[tableName] || [];
            const cols: ERColumn[] = colList.map((col: any) => ({
              name: col.name,
              type: col.type,
              isPrimaryKey: !!col.isPrimaryKey,
              isForeignKey: false,
              nullable: col.nullable,
            }));

            const tableFks = rawFks[tableName] || [];
            tableFks.forEach((fk: any) => {
              const matchingCol = cols.find((c) => c.name.toLowerCase() === (fk.column || '').toLowerCase());
              if (matchingCol) {
                matchingCol.isForeignKey = true;
                matchingCol.refTable = fk.refTable;
                matchingCol.refColumn = fk.refColumn;
              }

              parsedRels.push({
                id: `${tableName}.${fk.column}->${fk.refTable}.${fk.refColumn || fk.column}`,
                name: fk.name,
                sourceTable: tableName,
                sourceColumn: fk.column,
                targetTable: fk.refTable,
                targetColumn: fk.refColumn || fk.column,
              });
            });

            parsedTables.push({
              id: tableName,
              name: tableName,
              columns: cols,
            });
          });

          setTables(parsedTables);
          setRelationships(parsedRels);
        }
      } catch (err: any) {
        if (!active) return;
        console.error('Failed to load ER diagram data:', err);
        setError(err?.message || String(err));
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [connId]);

  if (loading) {
    return (
      <div className="er-loading-container">
        <Loader2 size={24} className="er-loading-spinner" />
        <span>{t('er.loadingSchema', 'Loading database schema & relationships...')}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="er-error-container">
        <AlertCircle size={28} className="er-error-icon" />
        <div className="er-error-title">{t('er.loadError', 'Failed to load ER Diagram')}</div>
        <div className="er-error-desc">{error}</div>
        <button type="button" className="btn btn-primary" onClick={loadData}>
          <RefreshCw size={13} />
          <span>{t('common.retry', 'Retry')}</span>
        </button>
      </div>
    );
  }

  if (tables.length === 0) {
    return (
      <div className="er-empty-container">
        <div className="er-empty-title">{t('er.emptyTitle', 'No tables found in this database')}</div>
        <div className="er-empty-desc">
          {t('er.emptyDesc', 'Create tables or connect to an existing database to generate the ER diagram.')}
        </div>
      </div>
    );
  }

  return (
    <div className="er-tab-wrapper">
      <ERDiagramView
        connId={connId}
        database={dbName}
        schema={schema}
        tables={tables}
        relationships={relationships}
        onOpenTable={onOpenTable}
      />
    </div>
  );
};
