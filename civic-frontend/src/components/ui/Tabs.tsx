import React, { useState, createContext, useContext, ReactNode } from 'react';
import { cn } from '../../utils/helpers';

// Context for managing tab state
type TabsContextType = {
  activeTab: string;
  setActiveTab: (id: string) => void;
};

const TabsContext = createContext<TabsContextType | undefined>(undefined);

function useTabs() {
  const context = useContext(TabsContext);
  if (!context) {
    throw new Error('Tabs components must be used within a TabsProvider');
  }
  return context;
}

// Props for the root Tabs component
interface TabsProps {
  defaultTab?: string;
  onChange?: (id: string) => void;
  children: ReactNode;
  className?: string;
}

// The main Tabs container
export function Tabs({ defaultTab, onChange, children, className }: TabsProps) {
  const [activeTab, setActiveTab] = useState(defaultTab || '');

  const handleTabChange = (id: string) => {
    setActiveTab(id);
    onChange?.(id);
  };

  return (
    <TabsContext.Provider value={{ activeTab, setActiveTab: handleTabChange }}>
      <div className={cn('tabs-container', className)}>
        {children}
      </div>
    </TabsContext.Provider>
  );
}

// Props for TabsList component
interface TabsListProps {
  children: ReactNode;
  className?: string;
}

// The container for tab buttons
export function TabsList({ children, className }: TabsListProps) {
  return (
    <div className={cn('flex space-x-1 border-b border-gray-200', className)}>
      {children}
    </div>
  );
}

// Props for TabTrigger component
interface TabTriggerProps {
  id: string;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
}

// The individual tab button
export function TabTrigger({ id, children, className, disabled = false }: TabTriggerProps) {
  const { activeTab, setActiveTab } = useTabs();
  const isActive = activeTab === id;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => setActiveTab(id)}
      className={cn(
        'px-4 py-2 text-sm font-medium transition-all',
        'focus:outline-none',
        isActive 
          ? 'border-b-2 border-blue-600 text-blue-600' 
          : 'text-gray-500 hover:text-gray-700 hover:border-b-2 hover:border-gray-300',
        disabled && 'pointer-events-none opacity-50',
        className
      )}
    >
      {children}
    </button>
  );
}

// Props for TabContent component
interface TabContentProps {
  id: string;
  children: ReactNode;
  className?: string;
}

// The content shown when a tab is active
export function TabContent({ id, children, className }: TabContentProps) {
  const { activeTab } = useTabs();
  const isActive = activeTab === id;

  if (!isActive) return null;

  return (
    <div className={cn('py-4', className)}>
      {children}
    </div>
  );
}