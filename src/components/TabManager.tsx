import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Table, Terminal, TerminalSquare, X, Plus, Trash2, XCircle, ArrowRight, ChevronDown, Cog, Braces, Layers, Pencil } from 'lucide-react';
import { TAB_GROUP_COLORS, type TabGroup } from '../utils/tabGroups';

export interface TabInfo {
  id: string;
  type: 'table' | 'query' | 'terminal' | 'routine' | 'view';
  name: string; // Table name or unique query title
  label: string;
  routineInfo?: { name: string; kind: 'procedure' | 'function'; sql: string };
  viewInfo?: { name: string; sql: string };
  config?: any;       // cấu hình kết nối cho tab terminal
  floating?: boolean; // terminal: đang ở chế độ cửa sổ nổi
  /** Nhóm chứa tab này. Bỏ trống = tab rời. Xem TabGroup. */
  groupId?: string;
}


interface TabManagerProps {
  tabs: TabInfo[];
  activeTabId: string | null;
  /** Tab còn sửa đổi chưa commit -> hiện chấm thay cho nút đóng. */
  dirtyTabId?: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string, e?: React.MouseEvent) => void;
  onCloseOthers?: (id: string) => void;
  onCloseTabsToRight?: (id: string) => void;
  onCloseAll?: () => void;
  /**
   * Kéo thả đổi thứ tự tab. Chỉ số tính trên mảng `tabs`; `groupId` là nhóm mà
   * con trỏ đang nằm trong vùng của nó lúc thả (undefined = ngoài mọi nhóm).
   */
  onReorderTabs?: (from: number, to: number, groupId: string | undefined) => void;
  onNewQueryTab: () => void;

  // ---- Nhóm tab ----
  groups?: TabGroup[];
  onCreateGroup?: (tabId: string) => void;
  onAssignGroup?: (tabId: string, groupId: string) => void;
  onRemoveFromGroup?: (tabId: string) => void;
  onRenameGroup?: (groupId: string, name: string) => void;
  onSetGroupColor?: (groupId: string, color: string) => void;
  onToggleGroup?: (groupId: string) => void;
  /** Kéo chip nhóm -> dời nguyên nhóm tới chỗ tab ở `targetIndex`. */
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

  // Đổi tên nhóm sửa tại chỗ trên chip (nháy đúp, hoặc từ menu chuột phải) thay
  // vì mở một hộp thoại — tên nhóm là nhãn ngắn, dựng cả một Modal cho nó thì
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
  // Trạng thái kéo: `from` là tab đang cầm, `to` là chỗ nó sẽ rơi vào, `dx` là
  // quãng đã kéo tính từ điểm bấm — tab được dịch đúng bằng dx nên nó bám theo
  // con trỏ. Đây mới là thứ cho biết đang cầm tab nào: chỉ làm mờ tab đi thì
  // trên tab không active (vốn đã chữ xám, nền trong suốt) gần như không thấy.
  const [drag, setDrag] = useState<
    { from: number; to: number; dx: number; toGroup: string | undefined } | null
  >(null);
  // Kéo nguyên một nhóm bằng chip của nó. Tách khỏi `drag` (kéo một tab) vì hai
  // thao tác có đơn vị khác nhau: một bên dời một tab, một bên dời cả dải.
  const [groupDrag, setGroupDrag] = useState<{ groupId: string; to: number; dx: number } | null>(null);
  // Sau một lần kéo, pointerup vẫn sinh tiếp một click -> bỏ qua click đó, nếu
  // không thì thả tab ở đâu cũng kèm việc chuyển sang tab đó (và thả chip nhóm
  // ở đâu cũng kèm thu gọn/mở nhóm đó).
  const skipClickRef = useRef(false);

  // Cuộn ngang bằng con lăn dọc: thanh tab là overflow-x với scrollbar bị ẩn,
  // nên khi tràn thì không có cách nào cuộn ngoài dropdown danh sách tab.
  // Phải tự addEventListener với passive: false — handler onWheel của React
  // được gắn ở gốc dưới dạng passive nên preventDefault() trong đó vô hiệu.
  useEffect(() => {
    const el = itemsRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // Shift+lăn đã là cuộn ngang sẵn của trình duyệt, để nguyên.
      if (e.shiftKey || e.deltaY === 0) return;
      if (el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Tab vừa chọn có thể đang nằm ngoài vùng nhìn thấy (mở từ sidebar, từ F12...).
  // Tra theo data-tab-id chứ không theo el.children[i]: từ khi có nhóm, con trực
  // tiếp của thanh tab có thể là một cụm .tab-group bọc nhiều tab, nên chỉ số con
  // không còn trùng chỉ số trong mảng `tabs`.
  useEffect(() => {
    if (!activeTabId) return;
    const node = itemsRef.current?.querySelector<HTMLElement>(
      `[data-tab-id="${CSS.escape(activeTabId)}"]`,
    );
    node?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId, tabs]);

  /**
   * Chỉ số (trong mảng `tabs`) của tab nằm dưới toạ độ x; ngoài hai đầu thì kẹp
   * về tab hiển thị đầu/cuối.
   *
   * Đọc chỉ số thật từ data-tab-index thay vì lấy vị trí trong danh sách node:
   * nhóm đang thu gọn giấu tab của nó đi, nên thứ tự node không còn liên tục.
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
   * Nhóm mà toạ độ x đang nằm trong vùng của nó, hoặc undefined nếu ở ngoài mọi
   * nhóm.
   *
   * Xác định bằng hình học của chính cụm .tab-group chứ không suy từ hai tab hàng
   * xóm: cách suy hàng xóm làm thả vào MÉP nhóm không nhận nhóm, mà thả vào mép
   * phải mới là thao tác tự nhiên nhất khi muốn thêm tab vào cuối một nhóm. Đo
   * theo vùng cũng là cách duy nhất thả được vào một nhóm đang thu gọn — lúc đó
   * nhóm chỉ còn cái chip, không có tab nào để làm hàng xóm.
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

  // Kéo thả bằng pointer event chứ không phải HTML5 drag-and-drop: cửa sổ Tauri
  // bật sẵn drag-drop cấp hệ điều hành, thứ này nuốt mất sự kiện drag trong
  // webview trên Windows. Pointer event không phụ thuộc vào đó.
  const handleTabPointerDown = (e: React.PointerEvent, index: number) => {
    if (e.button !== 0 || !onReorderTabs) return;
    const startX = e.clientX;
    const startGroup = tabs[index]?.groupId;
    let moved = false;
    let to = index;
    let toGroup = startGroup;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      // Ngưỡng 4px để một cú bấm hơi rung tay không bị hiểu là kéo.
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
      // Đổi nhóm cũng là một thay đổi, kể cả khi chỉ số không đổi: thả một tab
      // rời lên đúng mép nhóm bên cạnh giữ nguyên vị trí nhưng phải vào nhóm.
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
      // Chặn cú click sinh ra sau pointerup, kẻo kéo nhóm xong lại thu gọn nó.
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
    
    // Bounds check to keep context menu on screen. Phần nhóm làm menu dài ra
    // theo số nhóm hiện có, nên ước lượng phải cộng thêm chứ không để cứng 150 —
    // menu tràn đáy màn hình thì mục cuối bấm không tới.
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

  // Cắt mảng tab thành các cụm liên tiếp cùng nhóm. Dựa hoàn toàn vào bất biến
  // "tab cùng nhóm nằm liền nhau" mô tả ở TabGroup; groupId trỏ tới nhóm đã bị
  // xoá thì coi như tab rời, không cần dọn dẹp gì thêm ở đây.
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
    // phải thì nằm sau — đúng chỗ tab sẽ rơi vào sau khi splice. Áp cho cả kéo
    // một tab lẫn kéo nguyên nhóm; với nhóm thì mốc so sánh là tab ĐẦU của nhóm.
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
        // Hai thuộc tính data này là cách duy nhất để phần kéo thả biết node nào
        // ứng với tab nào: con trực tiếp của thanh tab không còn 1:1 với mảng
        // `tabs` từ khi có cụm nhóm và nhóm thu gọn.
        data-tab-id={tab.id}
        data-tab-index={index}
        // Chỉ dịch bằng transform, không đụng tới layout: các tab còn lại
        // đứng yên nên vạch chỉ chỗ thả không nhảy theo, và scrollWidth của
        // thanh tab không đổi giữa chừng khi kéo ra khỏi mép.
        style={isDragging ? { transform: `translateX(${drag!.dx}px)` } : undefined}
        onPointerDown={(e) => handleTabPointerDown(e, index)}
        onClick={() => {
          if (skipClickRef.current) {
            skipClickRef.current = false;
            return;
          }
          onSelectTab(tab.id);
        }}
        // Chuột giữa đóng tab. Chặn mousedown vì nút giữa mở chế độ
        // cuộn tự động của trình duyệt trước cả khi auxclick bắn ra.
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
            đậm cho tab đang xem), tiêu đề đã đủ cho biết đó là bảng hay
            truy vấn. Danh sách tab ở dropdown vẫn giữ icon. */}
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
    // Nhóm chứa tab đang xem thì luôn mở, kể cả khi đã đánh dấu thu gọn: giấu
    // đúng cái tab đang hiển thị nội dung là trạng thái không đọc được.
    const holdsActive = items.some((it) => it.tab.id === activeTabId);
    const collapsed = !!group.collapsed && !holdsActive;
    const renaming = renamingGroupId === group.id;
    const isDragging = groupDrag?.groupId === group.id;
    return (
      <div
        key={group.id}
        // data-group-id: groupAtX() đo vùng của cụm này để biết tab đang được
        // thả vào nhóm nào, nên id phải đọc được từ DOM.
        data-group-id={group.id}
        className={[
          'tab-group',
          collapsed ? 'collapsed' : '',
          // Sáng lên khi con trỏ đang ở trong vùng nhóm và tab được kéo sẽ rơi
          // vào đây — nếu không thì không có gì cho biết thả ra sẽ vào nhóm nào.
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
          // Kéo chip = dời nguyên nhóm. Bấm (không kéo) = thu gọn / mở ra.
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

  // Tab đang mở menu chuột phải, và nhóm của nó (nếu có). Đặt tên biến lặp là
  // `tb` chứ không phải `t`: `t` ở đây là hàm dịch, bị che là mất i18n cả file.
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

      {/* Menu chuột phải render QUA PORTAL ra <body>, không để tại chỗ trong
          .tab-bar. Menu dùng position: fixed với toạ độ clientX/clientY của
          viewport, nhưng .tab-bar có backdrop-filter (xem nhóm selector ở đầu
          index.css) mà thuộc tính đó tạo containing block mới cho con fixed —
          để trong đó thì toạ độ bị tính từ góc thanh tab, tức menu lệch xuống
          đúng chiều cao thanh tiêu đề và sang phải đúng bề rộng sidebar. Cùng
          cái bẫy đã ghi ở Modal.tsx.

          Ngược lại, .tab-list-dropdown (danh sách tab, nút ⌄) KHÔNG portal:
          nó là position: absolute neo vào chính .tab-bar, đúng như mong muốn. */}
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

              {/* Chuyển sang nhóm khác. Nhóm hiện tại của tab bị loại khỏi danh
                  sách: chọn nó cũng không đổi gì mà lại trông như một hành động. */}
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

