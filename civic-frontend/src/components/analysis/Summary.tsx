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
          <div className="p-1.5 bg-primary/10 rounded-md">
            <FileText className="h-5 w-5 text-primary" />
          </div>
          <h2 className="text-xl font-semibold text-white">Content Summary</h2>
        </div>
        
        {videoTitle && (
          <div className="flex items-center gap-2 mb-3 py-2 px-3 bg-white/5 rounded-lg border border-white/10">
            <Check className="h-4 w-4 text-primary/80" />
            <h3 className="text-base font-medium text-white/90">
              {videoTitle}
            </h3>
          </div>
        )}
      </div>
      
      <div className="relative rounded-lg bg-white/5 border border-white/10 p-4">
        <div className="prose prose-sm max-w-none text-white/90">
          {summary.split('\n').map((paragraph, index) => (
            <p key={index} className="mb-3 leading-relaxed">
              {paragraph}
            </p>
          ))}
        </div>
        
        <div className="absolute -top-2 -left-2">
          <div className="text-xs bg-primary text-white px-2 py-0.5 rounded font-medium shadow-sm">
            AI-Generated
          </div>
        </div>
      </div>
      
      <div className="mt-4 text-xs text-white/50 text-center">
        This summary was generated using AI to extract key points from the video content
      </div>
    </div>
  );
};

export default Summary;