import React, { useState, useRef, useEffect } from 'react';

interface TooltipProps {
  children: React.ReactNode;
  content: React.ReactNode;
  position?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
  className?: string;
}

const Tooltip: React.FC<TooltipProps> = ({
  children,
  content,
  position = 'top',
  delay = 300,
  className = ''
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const [coords, setCoords] = useState({ x: 0, y: 0 });
  const tooltipRef = useRef<HTMLDivElement>(null);
  const childRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  
  // Position the tooltip based on the child element
  const updatePosition = () => {
    if (!childRef.current || !tooltipRef.current) return;
    
    const childRect = childRef.current.getBoundingClientRect();
    const tooltipRect = tooltipRef.current.getBoundingClientRect();
    
    let x = 0;
    let y = 0;
    
    switch (position) {
      case 'top':
        x = childRect.left + (childRect.width / 2) - (tooltipRect.width / 2);
        y = childRect.top - tooltipRect.height - 8;
        break;
      case 'bottom':
        x = childRect.left + (childRect.width / 2) - (tooltipRect.width / 2);
        y = childRect.bottom + 8;
        break;
      case 'left':
        x = childRect.left - tooltipRect.width - 8;
        y = childRect.top + (childRect.height / 2) - (tooltipRect.height / 2);
        break;
      case 'right':
        x = childRect.right + 8;
        y = childRect.top + (childRect.height / 2) - (tooltipRect.height / 2);
        break;
    }
    
    // Ensure tooltip is within viewport
    x = Math.max(10, Math.min(x, window.innerWidth - tooltipRect.width - 10));
    y = Math.max(10, Math.min(y, window.innerHeight - tooltipRect.height - 10));
    
    setCoords({ x, y });
  };
  
  // Handle mouse events
  const handleMouseEnter = () => {
    timerRef.current = setTimeout(() => {
      setIsVisible(true);
      // Update position on next frame after tooltip is rendered
      requestAnimationFrame(updatePosition);
    }, delay);
  };
  
  const handleMouseLeave = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setIsVisible(false);
  };
  
  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);
  
  // Update position if content changes while visible
  useEffect(() => {
    if (isVisible) {
      updatePosition();
    }
  }, [content, isVisible]);
  
  return (
    <>
      <div
        ref={childRef}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        className="inline-block"
      >
        {children}
      </div>
      
      {isVisible && (
        <div
          ref={tooltipRef}
          className={`fixed z-50 px-2 py-1 text-sm bg-background-dark border border-white/20 rounded shadow-lg text-white max-w-xs ${className}`}
          style={{
            left: coords.x,
            top: coords.y,
          }}
        >
          {content}
          <div 
            className={`absolute w-2 h-2 bg-background-dark border-white/20 transform rotate-45 ${
              position === 'top' ? 'border-b border-r bottom-[-5px] left-1/2 -translate-x-1/2' :
              position === 'bottom' ? 'border-t border-l top-[-5px] left-1/2 -translate-x-1/2' :
              position === 'left' ? 'border-t border-r right-[-5px] top-1/2 -translate-y-1/2' :
              'border-b border-l left-[-5px] top-1/2 -translate-y-1/2'
            }`}
          />
        </div>
      )}
    </>
  );
};

export default Tooltip;
