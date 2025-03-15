import React, { useState } from 'react';
import { Play } from 'lucide-react';

interface VideoThumbnailProps {
  thumbnailUrl: string;
  videoTitle?: string;
}

const VideoThumbnail: React.FC<VideoThumbnailProps> = ({ thumbnailUrl, videoTitle }) => {
  const [modalOpen, setModalOpen] = useState(false);
  
  if (!thumbnailUrl) return null;
  
  // Extract video ID from thumbnail URL
  const extractVideoId = (url: string) => {
    const match = url.match(/\/vi\/([^/]+)\//);
    return match?.[1] || '';
  };
  
  const videoId = extractVideoId(thumbnailUrl);

  return (
    <>
      <div className="glass-panel p-6 cursor-pointer" onClick={() => setModalOpen(true)}>
        <div className="relative group overflow-hidden rounded-lg shadow-md border border-gray-200">
          <img 
            src={thumbnailUrl} 
            alt={videoTitle || "Video thumbnail"} 
            className="w-full h-auto rounded-lg transform transition-transform duration-300 group-hover:scale-105"
            onError={(e) => {
              // Set a fallback image if thumbnail loading fails
              e.currentTarget.src = 'https://via.placeholder.com/640x360?text=Video+Thumbnail';
            }}
          />
          <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-20 opacity-0 group-hover:opacity-100 transition-opacity">
            <div className="bg-white/30 backdrop-blur-sm p-4 rounded-full shadow-lg">
              <Play className="h-10 w-10 text-white" fill="white" />
            </div>
          </div>
          {videoTitle && (
            <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black to-transparent">
              <h3 className="text-white font-medium text-lg text-shadow">{videoTitle}</h3>
            </div>
          )}
        </div>
      </div>
      
      {/* Modal */}
      {modalOpen && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/80"
          onClick={() => setModalOpen(false)}
        >
          <div 
            className="relative w-full max-w-4xl bg-white rounded-xl overflow-hidden shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button 
              className="absolute top-4 right-4 z-10 p-1 rounded-full bg-black/50 text-white hover:bg-black/70"
              onClick={() => setModalOpen(false)}
            >
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            
            <div className="aspect-video w-full">
              <iframe
                width="100%"
                height="100%"
                src={`https://www.youtube.com/embed/${videoId}?autoplay=1&modestbranding=1&rel=0`}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                className="rounded-lg"
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default VideoThumbnail;