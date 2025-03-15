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
    const baseStyles = "inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none";
    
    // Variant styles for light theme
    const variantStyles = {
      default: "bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800 shadow-sm",
      secondary: "bg-gray-100 text-gray-800 hover:bg-gray-200 active:bg-gray-300 border border-gray-200",
      outline: "border border-gray-300 text-gray-800 hover:bg-gray-100 active:bg-gray-200",
      ghost: "text-gray-700 hover:bg-gray-100 active:bg-gray-200",
      link: "text-blue-600 underline-offset-4 hover:underline",
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