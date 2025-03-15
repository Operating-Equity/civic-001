import React, { useState } from 'react';
import { Copy, CheckCircle } from 'lucide-react';

interface TranscriptDisplayProps {
  transcript: string;
}

const TranscriptDisplay: React.FC<TranscriptDisplayProps> = ({ transcript }) => {
  const [copied, setCopied] = useState(false);
  
  if (!transcript) return null;
  
  const handleCopy = () => {
    navigator.clipboard.writeText(transcript);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  
  const paragraphs = transcript.split('\n').filter(p => p.trim().length > 0);

  return (
    <div className="glass-panel p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold text-gray-900">Transcript</h2>
        <button 
          onClick={handleCopy}
          className="flex items-center space-x-1.5 px-2 py-1 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg transition-colors"
        >
          {copied ? (
            <>
              <CheckCircle className="h-4 w-4 text-green-600" />
              <span className="text-sm">Copied</span>
            </>
          ) : (
            <>
              <Copy className="h-4 w-4" />
              <span className="text-sm">Copy</span>
            </>
          )}
        </button>
      </div>
      
      <div className="relative h-[300px] overflow-hidden rounded-lg border border-gray-200 bg-white">
        <div className="absolute top-0 right-0 bottom-0 left-0 overflow-auto p-4">
          <div className="space-y-4">
            {paragraphs.length > 0 ? (
              paragraphs.map((paragraph, index) => (
                <p key={index} className="text-sm leading-relaxed text-gray-700">
                  {paragraph}
                </p>
              ))
            ) : (
              <p className="text-sm text-gray-500 italic">
                The transcript appears to be empty. There might have been an issue with the transcription process.
              </p>
            )}
          </div>
        </div>
        <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-white to-transparent pointer-events-none"></div>
      </div>
    </div>
  );
};

export default TranscriptDisplay;