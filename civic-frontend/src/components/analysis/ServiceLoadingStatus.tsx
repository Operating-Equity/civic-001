import React from 'react';
import { AlertCircle, CheckCircle, XCircle, Clock } from 'lucide-react';

// Loading states for each service
export type ServiceStatus = 'idle' | 'loading' | 'success' | 'error';

interface ServiceLoadingStatusProps {
  perplexityStatus: ServiceStatus;
  openAIStatus: ServiceStatus;
  anthropicStatus: ServiceStatus;
  errorMessages?: {
    perplexity?: string;
    openai?: string;
    anthropic?: string;
  };
}

const ServiceLoadingStatus: React.FC<ServiceLoadingStatusProps> = ({
  perplexityStatus,
  openAIStatus,
  anthropicStatus,
  errorMessages = {}
}) => {
  // Function to get the appropriate icon for a status
  const getStatusIcon = (status: ServiceStatus) => {
    switch (status) {
      case 'idle':
        return <Clock className="h-5 w-5 text-gray-400" />;
      case 'loading':
        return (
          <div className="h-5 w-5 rounded-full border-2 border-blue-600 border-t-transparent animate-spin"></div>
        );
      case 'success':
        return <CheckCircle className="h-5 w-5 text-green-600" />;
      case 'error':
        return <XCircle className="h-5 w-5 text-red-600" />;
      default:
        return <AlertCircle className="h-5 w-5 text-gray-400" />;
    }
  };

  // Function to get the progress percentage based on status
  const getProgressPercentage = (status: ServiceStatus) => {
    switch (status) {
      case 'idle':
        return 0;
      case 'loading':
        return 50; // 50% when loading
      case 'success':
      case 'error':
        return 100; // 100% when complete (success or error)
      default:
        return 0;
    }
  };

  // Function to get the color class for the progress bar
  const getProgressBarColorClass = (status: ServiceStatus) => {
    switch (status) {
      case 'loading':
        return 'bg-blue-600';
      case 'success':
        return 'bg-green-600';
      case 'error':
        return 'bg-red-600';
      default:
        return 'bg-gray-200';
    }
  };

  // Function to get status text
  const getStatusText = (status: ServiceStatus, serviceName: string) => {
    switch (status) {
      case 'idle':
        return `Waiting to evaluate with ${serviceName}...`;
      case 'loading':
        return `Evaluating with ${serviceName}...`;
      case 'success':
        return `${serviceName} evaluation complete`;
      case 'error':
        return `${serviceName} evaluation failed`;
      default:
        return '';
    }
  };

  // Calculate overall progress percentage
  const calculateOverallProgress = () => {
    const statuses = [perplexityStatus, openAIStatus, anthropicStatus];
    const completedCount = statuses.filter(status => status === 'success' || status === 'error').length;
    const loadingCount = statuses.filter(status => status === 'loading').length;
    
    // Each completed service counts as 100%, each loading counts as 50%
    return Math.round((completedCount * 100 + loadingCount * 50) / 3);
  };

  const overallProgress = calculateOverallProgress();

  return (
    <div className="space-y-6">
      {/* Overall progress */}
      <div className="space-y-2">
        <div className="flex justify-between items-center">
          <div className="text-gray-800 font-medium">Overall Progress</div>
          <div className="text-gray-600 text-sm">{overallProgress}%</div>
        </div>
        <div className="h-2 bg-gray-100 rounded-full overflow-hidden border border-gray-200">
          <div 
            className="h-full bg-blue-600 rounded-full transition-all duration-500" 
            style={{ width: `${overallProgress}%` }}
          ></div>
        </div>
      </div>

      {/* Service-specific progress */}
      <div className="space-y-4">
        {/* Perplexity */}
        <div className="space-y-2">
          <div className="flex justify-between items-center">
            <div className="flex items-center space-x-2">
              {getStatusIcon(perplexityStatus)}
              <span className="text-gray-800 font-medium">Perplexity</span>
            </div>
            <div className="text-gray-600 text-sm">
              {getProgressPercentage(perplexityStatus)}%
            </div>
          </div>
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden border border-gray-200">
            <div 
              className={`h-full rounded-full transition-all duration-500 ${getProgressBarColorClass(perplexityStatus)}`}
              style={{ width: `${getProgressPercentage(perplexityStatus)}%` }}
            ></div>
          </div>
          <div className="text-sm text-gray-600">
            {getStatusText(perplexityStatus, 'Perplexity')}
            {perplexityStatus === 'error' && errorMessages.perplexity && (
              <div className="text-red-600 text-xs mt-1">{errorMessages.perplexity}</div>
            )}
          </div>
        </div>

        {/* OpenAI */}
        <div className="space-y-2">
          <div className="flex justify-between items-center">
            <div className="flex items-center space-x-2">
              {getStatusIcon(openAIStatus)}
              <span className="text-gray-800 font-medium">OpenAI</span>
            </div>
            <div className="text-gray-600 text-sm">
              {getProgressPercentage(openAIStatus)}%
            </div>
          </div>
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden border border-gray-200">
            <div 
              className={`h-full rounded-full transition-all duration-500 ${getProgressBarColorClass(openAIStatus)}`}
              style={{ width: `${getProgressPercentage(openAIStatus)}%` }}
            ></div>
          </div>
          <div className="text-sm text-gray-600">
            {getStatusText(openAIStatus, 'OpenAI')}
            {openAIStatus === 'error' && errorMessages.openai && (
              <div className="text-red-600 text-xs mt-1">{errorMessages.openai}</div>
            )}
          </div>
        </div>

        {/* Anthropic */}
        <div className="space-y-2">
          <div className="flex justify-between items-center">
            <div className="flex items-center space-x-2">
              {getStatusIcon(anthropicStatus)}
              <span className="text-gray-800 font-medium">Anthropic</span>
            </div>
            <div className="text-gray-600 text-sm">
              {getProgressPercentage(anthropicStatus)}%
            </div>
          </div>
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden border border-gray-200">
            <div 
              className={`h-full rounded-full transition-all duration-500 ${getProgressBarColorClass(anthropicStatus)}`}
              style={{ width: `${getProgressPercentage(anthropicStatus)}%` }}
            ></div>
          </div>
          <div className="text-sm text-gray-600">
            {getStatusText(anthropicStatus, 'Anthropic')}
            {anthropicStatus === 'error' && errorMessages.anthropic && (
              <div className="text-red-600 text-xs mt-1">{errorMessages.anthropic}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ServiceLoadingStatus;