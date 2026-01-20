import {
  Coins,
  RefreshCw,
  Shield,
  DollarSign,
  Camera,
  FolderSync,
  Search,
  Percent,
} from "lucide-react"

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

export type ModuleKey =
  | 'tokens'
  | 'actions'
  | 'backstop'
  | 'backstop-q4w'
  | 'lp-price'
  | 'pool-snapshots'
  | 'sync'
  | 'explore'

interface NavItem {
  key: ModuleKey
  label: string
  icon: React.ComponentType<{ className?: string }>
}

const navItems: NavItem[] = [
  { key: 'tokens', label: 'Tokens', icon: Coins },
  { key: 'actions', label: 'Actions Backfill', icon: RefreshCw },
  { key: 'backstop', label: 'Backstop Events', icon: Shield },
  { key: 'backstop-q4w', label: 'Backstop Q4W', icon: Percent },
  { key: 'lp-price', label: 'LP Price', icon: DollarSign },
  { key: 'pool-snapshots', label: 'Pool Snapshots', icon: Camera },
  { key: 'sync', label: 'Sync Pools', icon: FolderSync },
  { key: 'explore', label: 'Explore', icon: Search },
]

interface AppSidebarProps {
  activeModule: ModuleKey
  onModuleChange: (module: ModuleKey) => void
}

export function AppSidebar({ activeModule, onModuleChange }: AppSidebarProps) {
  return (
    <Sidebar>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.key}>
                  <SidebarMenuButton
                    isActive={activeModule === item.key}
                    onClick={() => onModuleChange(item.key)}
                  >
                    <item.icon />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  )
}
