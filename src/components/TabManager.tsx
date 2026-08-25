import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Table, Terminal, TerminalSquare, X, Plus, Trash2, XCircle, ArrowRight, ChevronDown, Cog, Braces, Layers, Pencil, Key, Activity, Timer, Radio, BarChart3 } from 'lucide-react';
import { TAB_GROUP_COLORS, type TabGroup } from '../utils/tabGroups';

export interface TabInfo {
  id: string;
  /**
   * Kết nối mà tab này run on.
   *
   * Trước đây constraint tab↔kết nối is **ngoại tại**: cả danh sách tab nằm under một key
   * localStorage of kết nối currently open, and đổi kết nối is thay trọn danh sách. Giờ tab of nhiều kết
   * nối cùng nằm in state, nên mỗi tab must tự mang kết nối of nó — tab bar filter theo đây, and
   * mọi component bên in tab receive `connId` này chứ not must "active connection".
   *
   * not bắt buộc: bản save in localStorage from trước when có trường này not có nó, and is gán
   * lúc khôi phục (xem `restoreTabs`).
   */
  connId?: string;
  /**
   * Bảy loại `redis-*` is tab of một kết nối Redis — cùng tab bar, cùng drag and drop, cùng nhóm màu
   * with tab SQL (`docs/redis-ui-unification-plan.md` §2.2).
   *
   * not loại nào mang `dbIndex`: một `conn_id` **is** một `(server, db index)` (§2.1), nên db
   * index nằm at `connId` at on. add nó ando đây is build lại đúng cái status dùng chung mà
   * Giai đoạn 0 vừa gỡ bỏ.
   */
  type:
    | 'table'
    | 'query'
    | 'terminal'
    | 'routine'
    | 'view'
    | 'redis-key'
    | 'redis-console'
    | 'redis-dashboard'
    | 'redis-slowlog'
    | 'redis-pubsub'
    | 'redis-profiler'
    | 'redis-analysis';
  name: string; // Table name or unique query title
  label: string;
  routineInfo?: { name: string; kind: 'procedure' | 'function'; sql: string };
  viewInfo?: { name: string; sql: string };
  /**
   * Tab `redis-key`. `keyType` chỉ to vẽ badge lúc chưa load xong giá trị — nguồn sự thật is lần
   * read key thật sự, vì kiểu can already đổi (key is delete rồi create lại) giữa hai phiên.
   */
  redisKeyInfo?: { keyName: string; keyType?: string };
  config?: any;       // configuration kết nối for tab terminal
  floating?: boolean; // terminal: currently at mode window nổi
  /** Nhóm chứa tab này. Bỏ trống = tab rời. Xem TabGroup. */
  groupId?: string;
}


/**
 * Icon for fromng loại tab Redis in dropdown danh sách tab.
 *
 * tab bar cố ý not vẽ icon (xem `renderTab`) — chỉ dropdown vẽ, nên table này chỉ dùng at đó.
 */
const REDIS_TAB_ICON: Record<string, React.FC<{ size?: number; style?: React.CSSProperties }>> = {
  'redis-key': Key,
  'redis-console': Terminal,
  'redis-dashboard': Activity,
  'redis-slowlog': Timer,
  'redis-pubsub': Radio,
  'redis-profiler': Activity,
  'redis-analysis': BarChart3,
};

interface TabManagerProps {
  tabs: TabInfo[];
  activeTabId: string | null;
  /** Tab còn edit đổi chưa commit -> hiện chấm thay for nút close. */
  dirtyTabId?: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string, e?: React.MouseEvent) => void;
  onCloseOthers?: (id: string) => void;
  onCloseTabsToRight?: (id: string) => void;
  onCloseAll?: () => void;
  /**
   * Kéo thả đổi thứ tự tab. Chỉ số tính on mảng `tabs`; `groupId` is nhóm mà
   * con trỏ currently nằm in vùng of nó lúc thả (undefined = ngoài mọi nhóm).
   */
  onReorderTabs?: (from: number, to: number, groupId: string | undefined) => void;
  onNewQueryTab: () => void;

  // ---- tab group ----
  groups?: TabGroup[];
  onCreateGroup?: (tabId: string) => void;
  onAssignGroup?: (tabId: string, groupId: string) => void;
  onRemoveFromGroup?: (tabId: string) => void;
  onRenameGroup?: (groupId: string, name: string) => void;
  onSetGroupColor?: (groupId: string, color: string) => void;
  onToggleGroup?: (groupId: string) => void;
  /** Kéo chip nhóm -> dời nguyên nhóm tới chỗ tab at `targetIndex`. */
  onMoveGroup?: (groupId: string, targetIndex: number) => void;
  onCloseGroup?: (groupId: string) => void;
}

export const TabManager: React.FC<TabManagerProps> = ({
  tabs,
  activeTabId,
  dirtyTabId,
  onSelectTab,
  onCloseTab,
  onCloseOthers,
  onCloseTabsToRight,
  onCloseAll,
  onReorderTabs,
  onNewQueryTab,
  groups = [],
  onCreateGroup,
  onAssignGroup,
  onRemoveFromGroup,
  onRenameGroup,
  onSetGroupColor,
  onToggleGroup,
  onMoveGroup,
  onCloseGroup,
}) => {
  const { t } = useTranslation();
  const [contextMenu, setContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
    tabId: string;
  }>({
    visible: false,
    x: 0,
    y: 0,
    tabId: '',
  });

  const [showListDropdown, setShowListDropdown] = useState(false);

  // rename nhóm edit tại chỗ on chip (nháy đúp, or from menu right click / context menu) thay
  // vì open một hộp thoại — tên nhóm is nhãn ngắn, build cả một Modal for nó thì
  // nặng hơn giá trị mang lại.
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  const commitRename = () => {
    if (!renamingGroupId) return;
    const name = renameDraft.trim();
    if (name) onRenameGroup?.(renamingGroupId, name);
    setRenamingGroupId(null);
  };

  const itemsRef = useRef<HTMLDivElement>(null);
  // status kéo: `from` is tab currently cầm, `to` is chỗ nó will rơi ando, `dx` is
  // quãng already kéo tính from điểm bấm — tab is dịch đúng bằng dx nên nó bám theo
  // con trỏ. Đây mới is thứ for biết currently cầm tab nào: chỉ ism mờ tab đi thì
  // on tab not active (vốn already chữ xám, nền in suốt) gần như not thấy.
  const [drag, setDrag] = useState<
    { from: number; to: number; dx: number; toGroup: string | undefined } | null
  >(null);
  // Kéo nguyên một nhóm bằng chip of nó. Tách khỏi `drag` (kéo một tab) vì hai
  // thao tác có đơn vị khác nhau: một bên dời một tab, một bên dời cả dải.
  const [groupDrag, setGroupDrag] = useState<{ groupId: string; to: number; dx: number } | null>(null);
  // Sau một lần kéo, pointerup vẫn sinh tiếp một click -> skip click đó, if
  // not thì thả tab at đâu cũng kèm việc chuyển sang tab đó (and thả chip nhóm
  // at đâu cũng kèm collapse/open nhóm đó).
  const skipClickRef = useRef(false);

  // Cuộn ngang bằng con lăn dọc: tab bar is overflow-x with scrollbar is hide,
  // nên when tràn thì not có cách nào cuộn ngoài dropdown danh sách tab.
  // must tự addEventListener with passive: false — handler onWheel of React
  // is gắn at gốc under dạng passive nên preventDefault() in đó vô hiệu.
  useEffect(() => {
    const el = itemsRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // Shift+lăn already is cuộn ngang sẵn of trình duyệt, to nguyên.
      if (e.shiftKey || e.deltaY === 0) return;
      if (el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Tab vừa select can currently nằm ngoài vùng nhìn thấy (open from sidebar, from F12...).
  // Tra theo data-tab-id chứ not theo el.children[i]: from when có nhóm, con trực
  // tiếp of tab bar can is một cụm .tab-group bọc nhiều tab, nên chỉ số con
  // not còn trùng chỉ số in mảng `tabs`.
  useEffect(() => {
    if (!activeTabId) return;
    const node = itemsRef.current?.querySelector<HTMLElement>(
      `[data-tab-id="${CSS.escape(activeTabId)}"]`,
    );
    node?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId, tabs]);

  /**
   * Chỉ số (in mảng `tabs`) of tab nằm under toạ độ x; ngoài hai đầu thì kẹp
   * về tab display đầu/cuối.
   *
   * read chỉ số thật from data-tab-index thay vì lấy position in danh sách node:
   * nhóm currently collapse giấu tab of nó đi, nên thứ tự node not còn liên tục.
   */
  const indexAtX = (x: number, fallback: number): number => {
    const el = itemsRef.current;
    if (!el) return fallback;
    const nodes = Array.from(el.querySelectorAll<HTMLElement>('.tab-item'));
    if (nodes.length === 0) return fallback;
    const realIndex = (node: HTMLElement) => Number(node.dataset.tabIndex ?? fallback);
    for (const node of nodes) {
      if (x < node.getBoundingClientRect().right) return realIndex(node);
    }
    return realIndex(nodes[nodes.length - 1]);
  };

  /**
   * Nhóm mà toạ độ x currently nằm in vùng of nó, or undefined if at ngoài mọi
   * nhóm.
   *
   * Xác định bằng hình học of chính cụm .tab-group chứ not suy from hai tab row
   * xóm: cách suy row xóm ism thả ando MÉP nhóm not receive nhóm, mà thả ando mép
   * must mới is thao tác tự nhiên nhất when muốn add tab ando cuối một nhóm. Đo
   * theo vùng cũng is cách unique thả is ando một nhóm currently collapse — lúc đó
   * nhóm chỉ còn cái chip, not có tab nào to ism row xóm.
   */
  const groupAtX = (x: number): string | undefined => {
    const el = itemsRef.current;
    if (!el) return undefined;
    for (const node of Array.from(el.querySelectorAll<HTMLElement>('.tab-group'))) {
      const rect = node.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right) return node.dataset.groupId;
    }
    return undefined;
  };

  // Kéo thả bằng pointer event chứ not must HTML5 drag-and-drop: window Tauri
  // bật sẵn drag-drop cấp hệ điều hành, thứ này nuốt mất sự kiện drag in
  // webview on Windows. Pointer event not phụ thuộc ando đó.
  const handleTabPointerDown = (e: React.PointerEvent, index: number) => {
    if (e.button !== 0 || !onReorderTabs) return;
    const startX = e.clientX;
    const startGroup = tabs[index]?.groupId;
    let moved = false;
    let to = index;
    let toGroup = startGroup;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      // Ngưỡng 4px to một cú bấm hơi rung tay not is hiểu is kéo.
      if (!moved && Math.abs(dx) < 4) return;
      moved = true;
      to = indexAtX(ev.clientX, index);
      toGroup = groupAtX(ev.clientX);
      setDrag({ from: index, to, dx, toGroup });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      setDrag(null);
      if (!moved) return;
      skipClickRef.current = true;
      // Đổi nhóm cũng is một change, kể cả when chỉ số not đổi: thả một tab
      // rời lên đúng mép nhóm bên cạnh preserve position nhưng must ando nhóm.
      if (to !== index || toGroup !== startGroup) onReorderTabs(index, to, toGroup);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const handleGroupPointerDown = (e: React.PointerEvent, groupId: string) => {
    if (e.button !== 0 || !onMoveGroup) return;
    const startX = e.clientX;
    let moved = false;
    let to = -1;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) < 4) return;
      moved = true;
      to = indexAtX(ev.clientX, -1);
      setGroupDrag({ groupId, to, dx });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      setGroupDrag(null);
      if (!moved) return;
      // Chặn cú click sinh ra sau pointerup, kẻo kéo nhóm xong lại collapse nó.
      skipClickRef.current = true;
      if (to >= 0) onMoveGroup(groupId, to);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  useEffect(() => {
    const closeAll = () => {
      setContextMenu((prev) => ({ ...prev, visible: false }));
      setShowListDropdown(false);
    };
    window.addEventListener('click', closeAll);
    window.addEventListener('contextmenu', closeAll);
    return () => {
      window.removeEventListener('click', closeAll);
      window.removeEventListener('contextmenu', closeAll);
    };
  }, []);

  const handleContextMenu = (e: React.MouseEvent, tabId: string) => {
    e.preventDefault();
    e.stopPropagation();
    
    // Bounds check to keep context menu on screen. Phần nhóm ism menu dài ra
    // theo số nhóm hiện có, nên ước lượng must cộng add chứ not to cứng 150 —
    // menu tràn đáy màn hình thì mục cuối bấm not tới.
    const ctxTabGroupId = tabs.find((tb) => tb.id === tabId)?.groupId;
    const menuWidth = 180;
    const menuHeight = 150 + 30 + groups.length * 26 + (ctxTabGroupId ? 120 : 0);
    let x = e.clientX;
    let y = e.clientY;
    
    if (x + menuWidth > window.innerWidth) {
      x = window.innerWidth - menuWidth - 10;
    }
    if (y + menuHeight > window.innerHeight) {
      y = window.innerHeight - menuHeight - 10;
    }
    
    setContextMenu({
      visible: true,
      x,
      y,
      tabId,
    });
  };

  // Cắt mảng tab thành các cụm liên tiếp cùng nhóm. Dựa hoàn toàn ando bất biến
  // "tab cùng nhóm nằm liền nhau" mô tả at TabGroup; groupId trỏ tới nhóm already is
  // delete thì coi như tab rời, not cần dọn dẹp gì add at đây.
  const segments: { group: TabGroup | null; items: { tab: TabInfo; index: number }[] }[] = [];
  tabs.forEach((tab, index) => {
    const group = (tab.groupId ? groups.find((g) => g.id === tab.groupId) : null) ?? null;
    const last = segments[segments.length - 1];
    if (last && (last.group?.id ?? null) === (group?.id ?? null)) {
      last.items.push({ tab, index });
    } else {
      segments.push({ group, items: [{ tab, index }] });
    }
  });

  const renderTab = ({ tab, index }: { tab: TabInfo; index: number }) => {
    const isActive = tab.id === activeTabId;
    const isDirty = tab.id === dirtyTabId;
    // Vạch chỉ chỗ thả: kéo sang trái thì vạch nằm trước tab đích, sang
    // must thì nằm sau — đúng chỗ tab will rơi ando sau when splice. Áp for cả kéo
    // một tab lẫn kéo nguyên nhóm; with nhóm thì mốc compare is tab ĐẦU of nhóm.
    const groupStart = groupDrag
      ? tabs.findIndex((it) => it.groupId === groupDrag.groupId)
      : -1;
    const dropSide =
      drag && drag.from !== drag.to && drag.to === index
        ? (drag.to < drag.from ? 'tab-drop-before' : 'tab-drop-after')
        : groupDrag && groupDrag.to === index && tab.groupId !== groupDrag.groupId
          ? (index < groupStart ? 'tab-drop-before' : 'tab-drop-after')
          : '';
    const isDragging = drag?.from === index;
    const classes = [
      'tab-item',
      isActive ? 'active' : '',
      isDirty ? 'dirty' : '',
      isDragging ? 'tab-dragging' : '',
      dropSide,
    ].filter(Boolean).join(' ');
    return (
      <div
        key={tab.id}
        className={classes}
        // Hai thuộc tính data này is cách unique to phần drag and drop biết node nào
        // ứng with tab nào: con trực tiếp of tab bar not còn 1:1 with mảng
        // `tabs` from when có cụm nhóm and nhóm collapse.
        data-tab-id={tab.id}
        data-tab-index={index}
        // Chỉ dịch bằng transform, not đụng tới layout: các tab còn lại
        // đứng yên nên vạch chỉ chỗ thả not nhảy theo, and scrollWidth of
        // tab bar not đổi giữa chừng when kéo ra khỏi mép.
        style={isDragging ? { transform: `translateX(${drag!.dx}px)` } : undefined}
        onPointerDown={(e) => handleTabPointerDown(e, index)}
        onClick={() => {
          if (skipClickRef.current) {
            skipClickRef.current = false;
            return;
          }
          onSelectTab(tab.id);
        }}
        // Chuột giữa close tab. Chặn mousedown vì nút giữa open mode
        // cuộn automatic of trình duyệt trước cả when auxclick bắn ra.
        onMouseDown={(e) => {
          if (e.button === 1) e.preventDefault();
        }}
        onAuxClick={(e) => {
          if (e.button !== 1) return;
          e.preventDefault();
          onCloseTab(tab.id, e);
        }}
        onContextMenu={(e) => handleContextMenu(e, tab.id)}
      >
        {/* Bỏ icon loại tab: tab chỉ phân biệt bằng màu (nền sáng + chữ
            đậm for tab currently xem), tiêu đề already đủ for biết đó is table hay
            query. Danh sách tab at dropdown vẫn giữ icon. */}
        <span className="tab-title" title={tab.label}>
          {tab.label}
        </span>
        {isDirty && (
          <span
            className="tab-dirty-dot"
            title={t('tabs.unsavedChanges')}
            aria-label={t('tabs.unsavedChanges')}
          />
        )}
        <button
          className="tab-close-btn"
          onClick={(e) => onCloseTab(tab.id, e)}
        >
          <X size={10} style={{ flexShrink: 0 }} />
        </button>
      </div>
    );
  };

  const renderGroup = (group: TabGroup, items: { tab: TabInfo; index: number }[]) => {
    // Nhóm chứa tab currently xem thì luôn open, kể cả when already đánh dấu collapse: giấu
    // đúng cái tab currently display nội dung is status not read is.
    const holdsActive = items.some((it) => it.tab.id === activeTabId);
    const collapsed = !!group.collapsed && !holdsActive;
    const renaming = renamingGroupId === group.id;
    const isDragging = groupDrag?.groupId === group.id;
    return (
      <div
        key={group.id}
        // data-group-id: groupAtX() đo vùng of cụm này to biết tab currently is
        // thả ando nhóm nào, nên id must read is from DOM.
        data-group-id={group.id}
        className={[
          'tab-group',
          collapsed ? 'collapsed' : '',
          // Sáng lên when con trỏ currently at in vùng nhóm and tab is kéo will rơi
          // ando đây — if not thì not có gì for biết thả ra will ando nhóm nào.
          drag && drag.toGroup === group.id ? 'drop-target' : '',
          isDragging ? 'tab-group-dragging' : '',
        ].filter(Boolean).join(' ')}
        style={{
          ['--tab-group-color' as string]: group.color,
          ...(isDragging ? { transform: `translateX(${groupDrag!.dx}px)` } : null),
        } as React.CSSProperties}
      >
        <div
          className="tab-group-chip"
          // Kéo chip = dời nguyên nhóm. Bấm (not kéo) = collapse / open ra.
          onPointerDown={(e) => handleGroupPointerDown(e, group.id)}
          onClick={() => {
            if (skipClickRef.current) {
              skipClickRef.current = false;
              return;
            }
            if (!renaming) onToggleGroup?.(group.id);
          }}
          onDoubleClick={() => {
            setRenamingGroupId(group.id);
            setRenameDraft(group.name);
          }}
          title={group.name}
        >
          <span className="tab-group-dot" />
          {renaming ? (
            <input
              type="text"
              className="tab-group-rename"
              value={renameDraft}
              autoFocus
              onChange={(e) => setRenameDraft(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') setRenamingGroupId(null);
              }}
            />
          ) : (
            <span className="tab-group-name">{group.name}</span>
          )}
          {collapsed && <span className="tab-group-count">{items.length}</span>}
        </div>
        {!collapsed && items.map(renderTab)}
      </div>
    );
  };

  // Tab currently open menu right click / context menu, and nhóm of nó (if có). Đặt tên biến lặp is
  // `tb` chứ not must `t`: `t` at đây is hàm dịch, is che is mất i18n cả file.
  const ctxTab = tabs.find((tb) => tb.id === contextMenu.tabId);
  const ctxGroup = (ctxTab?.groupId ? groups.find((g) => g.id === ctxTab.groupId) : null) ?? null;

  return (
    <div className="tab-bar">
      <div className="tab-bar-items" ref={itemsRef}>
        {segments.map((seg, i) =>
          seg.group ? renderGroup(seg.group, seg.items) : (
            <React.Fragment key={`plain_${i}`}>{seg.items.map(renderTab)}</React.Fragment>
          ),
        )}
      </div>

      <div className="tab-bar-controls">
        <button className="tab-new-btn" onClick={onNewQueryTab} title={t('tabs.newQueryTab')}>
          <Plus size={14} />
        </button>
        {tabs.length > 0 && (
          <button 
            className="tab-list-dropdown-btn" 
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setShowListDropdown((prev) => !prev);
            }}
            title={t('tabs.listOpenTabs')}
          >
            <ChevronDown size={14} />
          </button>
        )}
      </div>

      {showListDropdown && (
        <div className="tab-list-dropdown" onClick={(e) => e.stopPropagation()}>
          <div className="tab-list-dropdown-header">
            <span>{t('tabs.openTabs', { n: tabs.length })}</span>
            <button onClick={() => setShowListDropdown(false)}>×</button>
          </div>
          <div className="tab-list-dropdown-body">
            {tabs.map((tab) => {
              const isActive = tab.id === activeTabId;
              return (
                <div 
                  key={tab.id} 
                  className={`tab-list-dropdown-item ${isActive ? 'active' : ''}`}
                  onClick={() => {
                    onSelectTab(tab.id);
                    setShowListDropdown(false);
                  }}
                >
                  {tab.type === 'table' ? (
                    <Table size={12} className="tab-icon-table" style={{ marginRight: '6px' }} />
                  ) : tab.type === 'terminal' ? (
                    <TerminalSquare size={12} style={{ color: 'var(--win-accent)', marginRight: '6px' }} />
                  ) : tab.type === 'routine' ? (
                    tab.routineInfo?.kind === 'procedure' ? (
                      <Cog size={12} style={{ color: '#06b6d4', marginRight: '6px' }} />
                    ) : (
                      <Braces size={12} style={{ color: '#f59e0b', marginRight: '6px' }} />
                    )
                  ) : tab.type === 'view' ? (
                    <Layers size={12} style={{ color: '#8b5cf6', marginRight: '6px' }} />
                  ) : tab.type.startsWith('redis-') ? (
                    (() => {
                      const RedisIcon = REDIS_TAB_ICON[tab.type] ?? Key;
                      return <RedisIcon size={12} style={{ color: '#DC382D', marginRight: '6px' }} />;
                    })()
                  ) : (
                    <Terminal size={12} style={{ color: 'var(--win-accent)', marginRight: '6px' }} />
                  )}
                  <span className="tab-list-dropdown-title" title={tab.label}>{tab.label}</span>
                  <button 
                    className="tab-list-dropdown-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseTab(tab.id);
                    }}
                  >
                    <X size={10} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Menu right click / context menu render QUA PORTAL ra <body>, not to tại chỗ in
          .tab-bar. Menu dùng position: fixed with toạ độ clientX/clientY of
          viewport, nhưng .tab-bar có backdrop-filter (xem nhóm selector at đầu
          index.css) mà thuộc tính đó create containing block mới for con fixed —
          to in đó thì toạ độ is tính from góc tab bar, tức menu lệch xuống
          đúng height title bar and sang must đúng bề rộng sidebar. Cùng
          cái bẫy already write at Modal.tsx.

          Ngược lại, .tab-list-dropdown (danh sách tab, nút ⌄) not portal:
          nó is position: absolute neo ando chính .tab-bar, đúng như mong muốn. */}
      {contextMenu.visible && createPortal(
        <div
          className="tab-context-menu"
          style={{
            top: contextMenu.y,
            left: contextMenu.x,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="tab-context-menu-item"
            onClick={() => {
              onCloseTab(contextMenu.tabId);
              setContextMenu((prev) => ({ ...prev, visible: false }));
            }}
          >
            <X size={13} style={{ flexShrink: 0 }} />
            <span>{t('tabs.closeThis')}</span>
          </div>
          {onCloseOthers && (
            <div
              className="tab-context-menu-item"
              onClick={() => {
                onCloseOthers(contextMenu.tabId);
                setContextMenu((prev) => ({ ...prev, visible: false }));
              }}
            >
              <XCircle size={13} style={{ flexShrink: 0 }} />
              <span>{t('tabs.closeOthers')}</span>
            </div>
          )}
          {onCloseTabsToRight && (
            <div
              className="tab-context-menu-item"
              onClick={() => {
                onCloseTabsToRight(contextMenu.tabId);
                setContextMenu((prev) => ({ ...prev, visible: false }));
              }}
            >
              <ArrowRight size={13} style={{ flexShrink: 0 }} />
              <span>{t('tabs.closeToRight')}</span>
            </div>
          )}
          {onCreateGroup && (
            <>
              <div className="tab-context-menu-divider" />
              <div
                className="tab-context-menu-item"
                onClick={() => {
                  onCreateGroup(contextMenu.tabId);
                  setContextMenu((prev) => ({ ...prev, visible: false }));
                }}
              >
                <Layers size={13} style={{ flexShrink: 0 }} />
                <span>{t('tabs.newGroup')}</span>
              </div>

              {/* Chuyển sang nhóm khác. Nhóm hiện tại of tab is loại khỏi danh
                  sách: select nó cũng not đổi gì mà lại trông như một hành động. */}
              {groups
                .filter((g) => g.id !== ctxGroup?.id)
                .map((g) => (
                  <div
                    key={g.id}
                    className="tab-context-menu-item"
                    onClick={() => {
                      onAssignGroup?.(contextMenu.tabId, g.id);
                      setContextMenu((prev) => ({ ...prev, visible: false }));
                    }}
                  >
                    <span
                      className="tab-group-dot"
                      style={{ ['--tab-group-color' as string]: g.color } as React.CSSProperties}
                    />
                    <span>{g.name}</span>
                  </div>
                ))}

              {ctxGroup && (
                <>
                  <div
                    className="tab-context-menu-item"
                    onClick={() => {
                      onRemoveFromGroup?.(contextMenu.tabId);
                      setContextMenu((prev) => ({ ...prev, visible: false }));
                    }}
                  >
                    <XCircle size={13} style={{ flexShrink: 0 }} />
                    <span>{t('tabs.removeFromGroup')}</span>
                  </div>
                  <div
                    className="tab-context-menu-item"
                    onClick={() => {
                      setRenamingGroupId(ctxGroup.id);
                      setRenameDraft(ctxGroup.name);
                      setContextMenu((prev) => ({ ...prev, visible: false }));
                    }}
                  >
                    <Pencil size={13} style={{ flexShrink: 0 }} />
                    <span>{t('tabs.renameGroup')}</span>
                  </div>
                  <div className="tab-context-menu-colors">
                    {TAB_GROUP_COLORS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        className={`tab-group-swatch ${ctxGroup.color === color ? 'active' : ''}`}
                        style={{ background: color }}
                        title={t('tabs.groupColor')}
                        aria-label={t('tabs.groupColor')}
                        onClick={() => {
                          onSetGroupColor?.(ctxGroup.id, color);
                          setContextMenu((prev) => ({ ...prev, visible: false }));
                        }}
                      />
                    ))}
                  </div>
                  <div
                    className="tab-context-menu-item"
                    onClick={() => {
                      onCloseGroup?.(ctxGroup.id);
                      setContextMenu((prev) => ({ ...prev, visible: false }));
                    }}
                  >
                    <XCircle size={13} style={{ flexShrink: 0 }} />
                    <span>{t('tabs.closeGroup')}</span>
                  </div>
                </>
              )}
            </>
          )}
          {onCloseAll && (
            <>
              <div className="tab-context-menu-divider" />
              <div
                className="tab-context-menu-item close-all"
                onClick={() => {
                  onCloseAll();
                  setContextMenu((prev) => ({ ...prev, visible: false }));
                }}
                style={{ color: 'var(--st-danger)' }}
              >
                <Trash2 size={13} style={{ flexShrink: 0 }} />
                <span>{t('tabs.closeAll')}</span>
              </div>
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
};

