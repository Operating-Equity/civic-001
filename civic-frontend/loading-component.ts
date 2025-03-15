import React from 'react';

interface LoadingProps {
  size?: 'sm' | 'md' | 'lg';
  text?: string;
  subText?: string;
  fullScreen?: boolean;
}

const Loading: React.FC<LoadingProps> = ({
  size = 'md',
  text = 'Loading',
  subText,
  fullScreen = false,
}) => {
  const sizeClasses = {
    sm: 'h-6 w-6 border-2',
    md: 'h-10 w-10 border-3',
    lg: 'h-16 w-16 border-4',
  };
  
  const containerClasses = fullScreen
    ? 'fixed inset-0 z-50 flex items-center justify-center bg-background-dark/80'
    : 'flex flex-col items-center justify-center';

  return (
    <div className={containerClasses}>
      <div className="flex flex-col items-center space-y-4">
        <div
          className={`animate-spin rounded-full border-t-transparent border-primary ${sizeClasses[size]}`}
        />
        <div className="text-center">
          {text && <p className="text-white font-medium">{text}</p>}
          {subText && <p className="text-white/70 text-sm mt-1">{subText}</p>}
        </div>
      </div>
    </div>
  );
};

export default Loading;
