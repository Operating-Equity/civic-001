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
          bgColor: 'bg-green-100',
          borderColor: 'border-green-200',
          textColor: 'text-green-700',
          hoverColor: 'hover:bg-green-200',
          icon: CheckCircle
        };
      case 'FALSE':
        return {
          label: 'False',
          bgColor: 'bg-red-100',
          borderColor: 'border-red-200',
          textColor: 'text-red-700',
          hoverColor: 'hover:bg-red-200',
          icon: XCircle
        };
      case 'UNVERIFIED':
      default:
        return {
          label: 'Unverified',
          bgColor: 'bg-amber-100',
          borderColor: 'border-amber-200',
          textColor: 'text-amber-700',
          hoverColor: 'hover:bg-amber-200',
          icon: AlertCircle
        };
    }
  };

  const { label, bgColor, borderColor, textColor, icon: Icon } = getStatusConfig();
  
  const sizeClasses = {
    sm: 'text-xs px-2 py-0.5',
    md: 'text-sm px-3 py-1',
    lg: 'text-base px-4 py-1.5'
  };

  return (
    <span className={`
      ${bgColor} ${textColor} ${sizeClasses[size]} 
      rounded-full font-medium inline-flex items-center justify-center
      border ${borderColor} shadow-sm
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