import React from 'react';
import { FileText, Check } from 'lucide-react';

interface SummaryProps {
  summary: string;
  videoTitle?: string;
}

const Summary: React.FC<SummaryProps> = ({ summary, videoTitle }) => {
  if (!summary) return null;
  
  return (
    <div className="glass-panel p-6">
      <div className="mb-4">
        <div className="flex items-center space-x-2 mb-3">
          <div className="p-1.5 bg-blue-100 rounded-md">
            <FileText className="h-5 w-5 text-blue-600" />
          </div>
          <h2 className="text-xl font-semibold text-gray-900">Content Summary</h2>
        </div>
        
        {videoTitle && (
          <div className="flex items-center gap-2 mb-3 py-2 px-3 bg-gray-100 rounded-lg border border-gray-200">
            <Check className="h-4 w-4 text-blue-600" />
            <h3 className="text-base font-medium text-gray-800">
              {videoTitle}
            </h3>
          </div>
        )}
      </div>
      
      <div className="relative rounded-lg bg-white border border-gray-200 p-4 shadow-sm">
        <div className="prose prose-sm max-w-none text-gray-700">
          {summary.split('\n').map((paragraph, index) => (
            <p key={index} className="mb-3 leading-relaxed">
              {paragraph}
            </p>
          ))}
        </div>
        
        <div className="ai-generated-badge">
          AI-Generated
        </div>
      </div>
      
      <div className="mt-4 text-xs text-gray-500 text-center">
        This summary was generated using AI to extract key points from the video content
      </div>
    </div>
  );
};

export default Summary;