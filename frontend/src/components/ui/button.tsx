import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

const button = cva(
  'inline-flex items-center justify-center gap-2 rounded-full font-semibold transition-colors ' +
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ' +
    'disabled:opacity-50 disabled:pointer-events-none',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-on-primary hover:bg-primary/90',
        danger: 'bg-bad text-white hover:bg-bad/90',
        outline: 'border border-line bg-card text-ink hover:bg-muted',
        ghost: 'text-primary hover:bg-primary-soft/60',
        destructiveText: 'text-bad hover:bg-bad/10',
      },
      size: {
        md: 'h-11 px-5 text-sm',
        lg: 'h-14 px-6 text-base w-full',
        sm: 'h-9 px-3 text-sm',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof button> {}

export function Button({ className, variant, size, type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={cn(button({ variant, size }), className)} {...props} />;
}
