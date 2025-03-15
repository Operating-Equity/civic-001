import React from 'react';
import { AlertTriangle, XCircle, Info, AlertCircle } from 'lucide-react';

type ErrorType = 'error' | 'warning' | 'info';

interface ErrorMessageProps {
  type?: ErrorType;
  title?: string;
  message: string;
  onClose?: () => void;
  onRetry?: () => void;
}

const ErrorMessage: React.FC<ErrorMessageProps> = ({
  type = 'error',
  title,
  message,
  onClose,
  onRetry,
}) => {
  const getIcon = () => {
    switch (type) {
      case 'warning':
        return <AlertTriangle className="h-5 w-5 text-amber-400" />;
      case 'info':
        return <Info className="h-5 w-5 text-primary" />;
      case 'error':
      default:
        return <XCircle className="h-5 w-5 text-red-500" />;
    }
  };
  
  const getBackgroundColor = () => {
    switch (type) {
      case 'warning':
        return 'bg-amber-900/30 border-amber-500/30';
      case 'info':
        return 'bg-primary-900/30 border-primary/30';
      case 'error':
      default:
        return 'bg-red-900/30 border-red-500/30';
    }
  };

  return (
    <div className={`p-4 ${getBackgroundColor()} rounded-lg border`}>
      <div className="flex justify-between items-start">
        <div className="flex items-center space-x-2">
          {getIcon()}
          <span className="font-medium text-white">
            {title || type.charAt(0).toUpperCase() + type.slice(1)}
          </span>
        </div>
        
        {onClose && (
          <button
            onClick={onClose}
            className="text-white/70 hover:text-white"
          >
            <AlertCircle className="h-4 w-4" />
          </button>
        )}
      </div>
      
      <p className="mt-2 ml-7 text-white/90">{message}</p>
      
      {onRetry && (
        <div className="mt-3 ml-7">
          <button
            onClick={onRetry}
            className="px-3 py-1 bg-white/10 hover:bg-white/20 rounded-md text-white text-sm transition-colors"
          >
            Try Again
          </button>
        </div>
      )}
    </div>
  );
};

export default ErrorMessage;
