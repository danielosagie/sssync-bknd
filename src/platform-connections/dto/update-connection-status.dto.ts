import { IsIn, IsNotEmpty, IsString } from 'class-validator';
import { PlatformConnection } from '../platform-connections.service';

const validStatuses: PlatformConnection['Status'][] = [
    'active',
    'inactive',
    'pending',
    'needs_review',
    'scanning',
    'syncing',
    'reconciling',
    'error'
];

export class UpdateConnectionStatusDto {
    @IsString()
    @IsNotEmpty()
    @IsIn(validStatuses)
    status: PlatformConnection['Status'];
} 