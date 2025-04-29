import { IsArray, IsObject, IsOptional, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

// Define structure for confirmed matches/mappings/rules
class ConfirmedMatch {
    // Define properties based on what FE sends back
    sourceId: string;
    sssyncVariantId?: string; // ID if matched
    action: 'link' | 'create' | 'ignore';
}

class SyncRule {
    // Define properties e.g., syncInventory: boolean, createNew: boolean
}

export class ConfirmMappingsDto {
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => ConfirmedMatch)
    confirmedMatches: ConfirmedMatch[];

    @IsObject()
    @IsOptional()
    @Type(() => SyncRule)
    syncRules?: SyncRule;

    // Add other fields if needed (e.g., confirmed field mappings)
}
