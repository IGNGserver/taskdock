import type { FolderDto } from '@devtodo/contracts';
import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { directoryEntries } from '../directory-paths.js';
import { Select, TextField } from './m3e/index.js';

export function FolderPicker({
  folders,
  value,
  onChange,
  blocked = new Set<string>(),
  disabled = false,
  label = '目标文件夹',
}: {
  folders: readonly FolderDto[];
  value: string;
  onChange: (value: string) => void;
  blocked?: ReadonlySet<string>;
  disabled?: boolean;
  label?: string;
}) {
  const [query, setQuery] = useState('');
  const entries = useMemo(() => directoryEntries(folders), [folders]);
  const options = [
    { value: '', label: '根目录' },
    ...entries
      .filter((entry) => !blocked.has(entry.folder.id))
      .filter(
        (entry) =>
          entry.folder.id === value ||
          entry.label.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()),
      )
      .sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'))
      .map((entry) => ({ value: entry.folder.id, label: entry.label })),
  ];
  return (
    <div className="folder-picker">
      <TextField
        label="搜索文件夹"
        placeholder="搜索文件夹路径…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        disabled={disabled}
        leadingIcon={<Search size={16} />}
      />
      <Select
        label={label}
        value={value}
        onChange={onChange}
        disabled={disabled}
        options={options}
      />
    </div>
  );
}
