import type { HTMLAttributes } from 'react';

type BrandMarkProps = Omit<HTMLAttributes<HTMLSpanElement>, 'children'> & {
  size?: 'sm' | 'md' | 'lg';
};

export function BrandMark({ size = 'md', className = '', ...props }: BrandMarkProps) {
  return (
    <span
      {...props}
      aria-hidden="true"
      className={`brand-mark brand-mark--${size}${className ? ` ${className}` : ''}`}
    >
      <img src="/brand/taskdock-icon.png" alt="" />
    </span>
  );
}
