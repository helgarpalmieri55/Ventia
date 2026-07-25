-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "options" TEXT[] DEFAULT ARRAY[]::TEXT[];
