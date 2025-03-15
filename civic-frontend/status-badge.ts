import React from 'react';
import { CheckCircle, XCircle, AlertCircle } from 'lucide-react';
import { ClassificationType } from '../../types';

interface StatusBadgeProps {
  status: ClassificationType;
  size?: 'sm' | 'md' | 'lg';
  withIcon?: boolean;
}

const StatusBadge: React.FC<StatusBadgeProps> = ({ 
  status, 
  size = 'md',
  withIcon = true 
}) => {
  const getStatusConfig = () => {
    switch (status) {
      case 'TRUE':
        return {
          label: 'True',
          color: 'bg-status-true',
          textColor: 'text-white',
          hoverColor: 'hover:bg-green-600',
          icon: CheckCircle
        };
      case 'FALSE':
        return {
          label: 'False',
          color: 'bg-status-false',
          textColor: 'text-white',
          hoverColor: 'hover:bg-red-600',
          icon: XCircle
        };
      case 'UNVERIFIED':
      default:
        return {
          label: 'Unverified',
          color: 'bg-status-unverified',
          textColor: 'text-white',
          hoverColor: 'hover:bg-amber-600',
          icon: AlertCircle
        };
    }
  };

  const { label, color, textColor, icon: Icon } = getStatusConfig();
  
  const sizeClasses = {
    sm: 'text-xs px-2 py-0.5',
    md: 'text-sm px-3 py-1',
    lg: 'text-base px-4 py-1.5'
  };

  return (
    <span className={`
      ${color} ${textColor} ${sizeClasses[size]} 
      rounded-full font-medium inline-flex items-center justify-center
      shadow-sm
    `}>
      {withIcon && (
        <Icon className={`
          ${size === 'sm' ? 'h-3 w-3 mr-1' : size === 'md' ? 'h-4 w-4 mr-1.5' : 'h-5 w-5 mr-2'}
        `} />
      )}
      {label}
    </span>
  );
};

export default StatusBadge;
