import React, { useState } from 'react';
import { Play, Shield, CheckCircle } from 'lucide-react';

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
          {/* Thumbnail Image */}
          <img 
            src={thumbnailUrl} 
            alt={videoTitle || "Video thumbnail"} 
            className="w-full h-auto rounded-lg transform transition-transform duration-300 group-hover:scale-105"
            onError={(e) => {
              // Set a fallback image if thumbnail loading fails
              e.currentTarget.src = 'https://via.placeholder.com/640x360?text=Video+Thumbnail';
            }}
          />
          
          {/* Civic Branding Overlay - Top Left Corner (premium placement) */}
          <div className="absolute top-4 left-4 flex items-center bg-white bg-opacity-90 px-3 py-2 rounded-lg shadow-lg">
            <div className="bg-blue-600 p-1.5 rounded mr-2 flex-shrink-0">
              <Shield className="h-4 w-4 text-white" />
            </div>
            <div className="flex flex-col">
              <span className="font-bold text-blue-600 text-sm leading-tight">VERIFIED</span>
              <span className="text-xs text-gray-700">by Civic</span>
            </div>
          </div>
          
          {/* Video Title with slightly transparent background for better readability */}
          {videoTitle && (
            <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black via-black/70 to-transparent">
              <h3 className="text-white font-medium text-lg leading-tight">{videoTitle}</h3>
            </div>
          )}
          
          {/* Play Button Overlay */}
          <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300">
            <div className="bg-blue-600 bg-opacity-90 p-5 rounded-full shadow-lg transform group-hover:scale-110 transition-transform duration-300">
              <Play className="h-10 w-10 text-white" fill="white" />
            </div>
          </div>
          
          {/* Additional subtle branding in corner */}
          <div className="absolute bottom-4 right-4 opacity-80">
            <div className="flex items-center bg-black bg-opacity-60 rounded-full px-2 py-1">
              <CheckCircle className="h-3 w-3 text-blue-400 mr-1" />
              <span className="text-white text-xs font-medium">Fact-Checked</span>
            </div>
          </div>
        </div>
      </div>
      
      {/* Modal */}
      {modalOpen && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/90"
          onClick={() => setModalOpen(false)}
        >
          <div 
            className="relative w-full max-w-4xl bg-white rounded-xl overflow-hidden shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Close Button */}
            <button 
              className="absolute top-4 right-4 z-10 p-1 rounded-full bg-black/60 text-white hover:bg-black/80 transition-colors"
              onClick={() => setModalOpen(false)}
            >
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            
            {/* Video Player */}
            <div className="aspect-video w-full relative">
              <iframe
                width="100%"
                height="100%"
                src={`https://www.youtube.com/embed/${videoId}?autoplay=1&modestbranding=1&rel=0`}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                className="rounded-b-lg"
              />
              
              {/* Persistent Branding Bar on top of video */}
              <div className="absolute top-0 left-0 right-0 bg-gradient-to-b from-black/70 to-transparent p-3 flex items-center justify-between">
                <div className="flex items-center">
                  <div className="bg-blue-600 p-1 rounded mr-2">
                    <Shield className="h-4 w-4 text-white" />
                  </div>
                  <span className="text-white font-medium text-sm">Verified by Civic</span>
                </div>
                <div className="flex items-center text-white text-xs bg-blue-600/90 px-2 py-0.5 rounded-full">
                  <CheckCircle className="h-3 w-3 mr-1" />
                  <span>Fact-Checked Content</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default VideoThumbnail;