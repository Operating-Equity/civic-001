import React from 'react';
import { FileText } from 'lucide-react';

interface SummaryProps {
  summary: string;
  videoTitle?: string;
}

const Summary: React.FC<SummaryProps> = ({ summary, videoTitle }) => {
  if (!summary) return null;
  
  return (
    <div className="glass-panel p-6">
      <div className="flex items-center space-x-2 mb-4">
        <FileText className="h-5 w-5 text-primary" />
        <h2 className="text-xl font-semibold text-white">Summary</h2>
      </div>
      
      <div className="relative h-[200px] overflow-hidden rounded-md">
        <div className="absolute top-0 right-0 bottom-0 left-0 overflow-auto custom-scrollbar pr-2">
          {videoTitle && (
            <h3 className="text-lg font-medium mb-3 text-white/90">
              {videoTitle}
            </h3>
          )}
          
          <div className="prose prose-sm max-w-none text-white/90">
            {summary.split('\n').map((paragraph, index) => (
              <p key={index} className="mb-3 leading-relaxed">
                {paragraph}
              </p>
            ))}
          </div>
        </div>
        <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-background-dark to-transparent pointer-events-none"></div>
      </div>
    </div>
  );
};

export default Summary;
