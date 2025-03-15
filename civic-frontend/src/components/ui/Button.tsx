import React, { ButtonHTMLAttributes, forwardRef } from 'react';
import { cn } from '../../utils/helpers';

export type ButtonVariant = 'default' | 'secondary' | 'outline' | 'ghost' | 'link';
export type ButtonSize = 'default' | 'sm' | 'lg' | 'icon';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  isLoading?: boolean;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ 
    className, 
    children, 
    variant = 'default', 
    size = 'default', 
    isLoading = false, 
    disabled, 
    ...props 
  }, ref) => {
    // Base styles
    const baseStyles = "inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none";
    
    // Variant styles
    const variantStyles = {
      default: "bg-primary text-white hover:bg-primary-600 active:bg-primary-700",
      secondary: "bg-white/10 text-white hover:bg-white/20 active:bg-white/30",
      outline: "border border-white/20 text-white hover:bg-white/10 active:bg-white/20",
      ghost: "text-white hover:bg-white/10 active:bg-white/20",
      link: "text-primary underline-offset-4 hover:underline",
    };
    
    // Size styles
    const sizeStyles = {
      default: "h-10 py-2 px-4",
      sm: "h-8 px-3 text-xs",
      lg: "h-12 px-6 text-base",
      icon: "h-10 w-10 p-2",
    };

    return (
      <button
        className={cn(
          baseStyles,
          variantStyles[variant],
          sizeStyles[size],
          className
        )}
        ref={ref}
        disabled={isLoading || disabled}
        {...props}
      >
        {isLoading && (
          <div className="mr-2">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"></div>
          </div>
        )}
        {children}
      </button>
    );
  }
);

Button.displayName = "Button";

export { Button };